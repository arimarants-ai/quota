package app.hitquota.quota;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Quota's own plugin lives in the app rather than in a package, so it is handed over here.
        registerPlugin(QuotaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
