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

// CapacitorHttp returns a finished body, so Ask the shelf reads the Fly response
// on the Android side and forwards each chunk to the WebView as it arrives.
@CapacitorPlugin(name = "ShelfNative")
public class ShelfNativePlugin extends Plugin {
    @PluginMethod
    public void stream(PluginCall call) {
        String url = call.getString("url");
        String body = call.getString("body");
        String requestId = call.getString("requestId");
        if (url == null || body == null || requestId == null) {
            call.reject("Missing request");
            return;
        }
        getBridge().execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
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
                    int count;
                    while ((count = reader.read(buffer)) != -1) {
                        JSObject event = new JSObject();
                        event.put("requestId", requestId);
                        event.put("text", new String(buffer, 0, count));
                        notifyListeners("chunk", event);
                    }
                }
                JSObject done = new JSObject();
                done.put("requestId", requestId);
                call.resolve(done);
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "ask failed" : error.getMessage());
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
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
