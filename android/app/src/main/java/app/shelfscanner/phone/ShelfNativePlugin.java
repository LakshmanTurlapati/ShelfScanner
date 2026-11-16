package app.shelfscanner.phone;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// CapacitorHttp returns a finished body, so Ask the shelf reads the Fly response
// on the Android side and forwards each chunk to the WebView as it arrives.
// Every plugin method shares one bridge thread, so the stream runs on its own pool;
// blocking that thread would queue every other native call behind the answer.
@CapacitorPlugin(name = "ShelfNative")
public class ShelfNativePlugin extends Plugin {
    private final ExecutorService streams = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> open = new ConcurrentHashMap<>();

    private boolean allowed(URL target) {
        String host = getContext().getString(R.string.shelf_api_host);
        return "https".equals(target.getProtocol()) && host.equalsIgnoreCase(target.getHost());
    }

    @PluginMethod
    public void stream(PluginCall call) {
        String url = call.getString("url");
        String body = call.getString("body");
        String requestId = call.getString("requestId");
        if (url == null || body == null || requestId == null) {
            call.reject("Missing request");
            return;
        }
        final URL target;
        try {
            target = new URL(url);
        } catch (Exception error) {
            call.reject("Bad address");
            return;
        }
        if (!allowed(target)) {
            call.reject("Address not allowed");
            return;
        }
        streams.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) target.openConnection();
                open.put(requestId, connection);
                connection.setConnectTimeout(20_000);
                connection.setReadTimeout(60_000);
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setUseCaches(false);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("Accept", "text/plain");
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    call.reject(String.valueOf(status));
                    return;
                }
                try (InputStreamReader reader = new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8)) {
                    char[] buffer = new char[256];
                    // A high surrogate at the end of a read waits for its pair, so an emoji is never split
                    // across two events (a lone surrogate cannot cross into the WebView intact).
                    String carry = "";
                    int count;
                    while ((count = reader.read(buffer)) != -1) {
                        String text = carry + new String(buffer, 0, count);
                        carry = "";
                        if (!text.isEmpty() && Character.isHighSurrogate(text.charAt(text.length() - 1))) {
                            carry = text.substring(text.length() - 1);
                            text = text.substring(0, text.length() - 1);
                        }
                        if (!text.isEmpty()) emit(requestId, text);
                    }
                    if (!carry.isEmpty()) emit(requestId, carry);
                }
                JSObject done = new JSObject();
                done.put("requestId", requestId);
                call.resolve(done);
            } catch (Exception error) {
                call.reject(open.containsKey(requestId) ? (error.getMessage() == null ? "ask failed" : error.getMessage()) : "cancelled");
            } finally {
                open.remove(requestId);
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void emit(String requestId, String text) {
        JSObject event = new JSObject();
        event.put("requestId", requestId);
        event.put("text", text);
        notifyListeners("chunk", event);
    }

    // Disconnecting makes the blocked read throw, which ends that stream's task.
    @PluginMethod
    public void cancel(PluginCall call) {
        String requestId = call.getString("requestId");
        HttpURLConnection connection = requestId == null ? null : open.remove(requestId);
        if (connection != null) streams.execute(connection::disconnect);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (HttpURLConnection connection : open.values()) connection.disconnect();
        open.clear();
        streams.shutdownNow();
    }

    @PluginMethod
    public void isOnline(PluginCall call) {
        try {
            ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            Network network = manager == null ? null : manager.getActiveNetwork();
            NetworkCapabilities caps = network == null || manager == null ? null : manager.getNetworkCapabilities(network);
            boolean online = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            JSObject result = new JSObject();
            result.put("online", online);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "offline" : error.getMessage());
        }
    }

    @PluginMethod
    public void cameraAccess(PluginCall call) {
        boolean granted = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        JSObject result = new JSObject();
        if (granted) result.put("state", "granted");
        else if (getActivity() != null && ActivityCompat.shouldShowRequestPermissionRationale(getActivity(), Manifest.permission.CAMERA)) result.put("state", "denied");
        else result.put("state", "blocked");
        call.resolve(result);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
