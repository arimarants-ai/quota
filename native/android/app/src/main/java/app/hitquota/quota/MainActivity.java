package app.hitquota.quota;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Quota's own plugins live in the app rather than in a package, so they are handed over here.
        registerPlugin(QuotaPlugin.class);
        registerPlugin(DualCamPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
