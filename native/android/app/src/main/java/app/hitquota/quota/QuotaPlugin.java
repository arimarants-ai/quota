package app.hitquota.quota;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// What the page tells the phone about today, for the parts of Quota that live outside the
// app: the streak widget and the countdown notification. The page works out every number;
// this stores it where the widget and the 10:15pm alarm can read it. Same three calls as
// the iPhone's, so the page does not care which phone it is on.
@CapacitorPlugin(name = "Quota")
public class QuotaPlugin extends Plugin {
    @PluginMethod
    public void setWidget(PluginCall call) {
        JSObject data = call.getData();
        Today.save(getContext(), data.toString());
        StreakWidget.updateAll(getContext());
        Countdown.schedule(getContext());
        call.resolve();
    }

    @PluginMethod
    public void startCountdown(PluginCall call) {
        double deadline = call.getDouble("deadline", 0.0);
        boolean shown = Countdown.show(getContext(), call.getInt("streak", 0), call.getString("left", ""),
                call.getString("crew", ""), (long) (deadline * 1000));
        JSObject out = new JSObject();
        out.put("started", shown);
        if (!shown) out.put("reason", "notifications off");
        call.resolve(out);
    }

    @PluginMethod
    public void endCountdown(PluginCall call) {
        Countdown.cancel(getContext());
        call.resolve();
    }
}
