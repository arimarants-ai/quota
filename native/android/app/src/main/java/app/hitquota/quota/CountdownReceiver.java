package app.hitquota.quota;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// The 8pm, 10:15pm and midnight alarms. At 8pm the widget turns to its last hours and nothing
// else changes. At 10:15 the countdown goes up if today is still owed by what the app last
// knew; at midnight it comes down and the widgets move to the new day.
public class CountdownReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        Today t = Today.read(c);
        String what = intent.getStringExtra("what");
        if ("evening".equals(what)) {
            StreakWidget.updateAll(c);
            Countdown.schedule(c);
            return;
        }
        if ("lastCall".equals(what)) {
            if (t.owing()) Countdown.show(c, t.streak, t.unit, t.left, t.crew, Today.midnightAfter(System.currentTimeMillis()));
        } else {
            Countdown.cancel(c);
        }
        StreakWidget.updateAll(c);
        MotivationWidget.updateAll(c);
        Countdown.schedule(c);
    }
}
