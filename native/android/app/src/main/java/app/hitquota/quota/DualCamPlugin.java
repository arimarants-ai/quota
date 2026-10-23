package app.hitquota.quota;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

// Front and back at the same moment, for the Play Store app. The same two calls as the
// iPhone's, so the page does not care which phone it is on: isAvailable() when Quota's own
// camera opens, and capture() when its front-and-back button is tapped. The camera itself
// is DualCamActivity.
@CapacitorPlugin(name = "DualCam")
public class DualCamPlugin extends Plugin {
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", DualCamActivity.pair(getContext()) != null);
        call.resolve(out);
    }

    // { mode: 'photo' | 'video', maxSeconds?: number }
    //   -> { path, mime, seconds }, or rejected with code CANCELLED / DENIED / UNAVAILABLE.
    @PluginMethod
    public void capture(PluginCall call) {
        if (DualCamActivity.pair(getContext()) == null) {
            call.reject("This phone can't run both cameras at once.", "UNAVAILABLE");
            return;
        }
        // The page's camera has already asked for these; without the camera there is nothing
        // to do, and a clip without the microphone is recorded without sound.
        if (getContext().checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Quota isn't allowed to use the camera.", "DENIED");
            return;
        }
        Intent i = new Intent(getContext(), DualCamActivity.class);
        i.putExtra("video", "video".equals(call.getString("mode", "photo")));
        Double max = call.getDouble("maxSeconds", 0.0);
        i.putExtra("maxSeconds", max == null ? 0.0 : max);
        i.putExtra("flash", Boolean.TRUE.equals(call.getBoolean("flash", false)));
        startActivityForResult(call, i, "captured");
    }

    @ActivityCallback
    private void captured(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null && data.getStringExtra("path") != null) {
            JSObject out = new JSObject();
            out.put("path", data.getStringExtra("path"));
            out.put("mime", data.getStringExtra("mime"));
            out.put("seconds", data.getDoubleExtra("seconds", 0));
            call.resolve(out);
            return;
        }
        String why = data == null ? null : data.getStringExtra("error");
        if (why == null) call.reject("Closed.", "CANCELLED");
        else call.reject(why, "UNAVAILABLE");
    }
}
