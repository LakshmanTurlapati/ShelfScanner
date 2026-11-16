package app.shelfscanner.phone;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShelfNativePlugin.class);
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(false);
            controller.setAppearanceLightNavigationBars(false);
        }
        FrameLayout scrims = new FrameLayout(this);
        scrims.setClickable(false);
        View status = new View(this);
        status.setBackgroundColor(0xFF141110);
        View navigation = new View(this);
        navigation.setBackgroundColor(0xFF141110);
        scrims.addView(status, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.TOP));
        scrims.addView(navigation, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.BOTTOM));
        addContentView(scrims, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ViewCompat.setOnApplyWindowInsetsListener(scrims, (view, insets) -> {
            status.getLayoutParams().height = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top;
            navigation.getLayoutParams().height = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom;
            status.requestLayout();
            navigation.requestLayout();
            return insets;
        });
        ViewCompat.requestApplyInsets(scrims);
    }
}
