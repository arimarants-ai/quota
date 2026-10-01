package app.hitquota.quota;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// The 10:15pm and midnight alarms. At 10:15 the countdown goes up if today is still owed by
// what the app last knew; at midnight it comes down and the widget moves to the new day.
public class CountdownReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        Today t = Today.read(c);
        if ("lastCall".equals(intent.getStringExtra("what"))) {
            if (t.owing()) Countdown.show(c, t.streak, t.left, t.crew, Today.midnightAfter(System.currentTimeMillis()));
        } else {
            Countdown.cancel(c);
        }
        StreakWidget.updateAll(c);
        Countdown.schedule(c);
    }
}
