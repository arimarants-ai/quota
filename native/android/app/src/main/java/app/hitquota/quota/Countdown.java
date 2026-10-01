package app.hitquota.quota;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

// The end-of-day countdown on Android: one pinned notification with a clock running down to
// midnight. Every Android phone shows it in the shade; Android 16 phones (Samsung's One UI 8,
// recent Pixels) also lift it into the status bar, and on a Samsung into the Now Bar.
//
// It starts on its own: an alarm at 10:15pm checks what the app last said about today. The
// app also starts it while open, and ends it the moment today's proof is in.
//
// ponytail: the alarm is set again every time the app opens, not after a restart. A phone
// restarted and not opened since misses that night's countdown; a boot receiver fixes that.
final class Countdown {
    static final String CHANNEL = "countdown";
    static final int ID = 2215;
    private static final int RC_LAST_CALL = 1;
    private static final int RC_MIDNIGHT = 2;

    static boolean show(Context c, int streak, String left, String crew, long deadline) {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        channel(c);
        long now = System.currentTimeMillis();
        if (deadline <= now) return false;
        String title = streak > 0 ? "Your " + streak + " day streak ends at midnight" : "Post today to start your streak";
        String text = left.isEmpty() ? "Post proof before midnight." : left + " to go";
        if (!crew.isEmpty()) text += " · " + crew;
        PendingIntent record = PendingIntent.getActivity(c, 0,
                new Intent(Intent.ACTION_VIEW, Uri.parse("hitquota://record"), c, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_quota)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setColor(0xFF0B5A34)
                .setWhen(deadline)
                .setShowWhen(true)
                .setUsesChronometer(true)
                .setChronometerCountDown(true)
                .setTimeoutAfter(deadline - now)
                .setContentIntent(record)
                .addAction(0, "Record now", record);
        // Android 16's Live Updates: asks for the status-bar chip and Samsung's Now Bar. A
        // phone that does not know the key ignores it.
        b.getExtras().putBoolean("android.requestPromotedOngoing", true);
        try {
            NotificationManagerCompat.from(c).notify(ID, b.build());
        } catch (SecurityException e) {
            return false;
        }
        return true;
    }

    static void cancel(Context c) {
        NotificationManagerCompat.from(c).cancel(ID);
    }

    // The next 10:15pm, and the next midnight (to put the widget onto the new day).
    static void schedule(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long now = System.currentTimeMillis();
        long call = Today.lastCall(now);
        if (call <= now) call = Today.lastCall(Today.midnightAfter(now));
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, call, alarm(c, RC_LAST_CALL));
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, Today.midnightAfter(now) + 30_000, alarm(c, RC_MIDNIGHT));
    }

    private static PendingIntent alarm(Context c, int code) {
        Intent i = new Intent(c, CountdownReceiver.class).putExtra("what", code == RC_LAST_CALL ? "lastCall" : "midnight");
        return PendingIntent.getBroadcast(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void channel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "End-of-day countdown", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("From 10:15pm, the time left to post today's proof.");
        nm.createNotificationChannel(ch);
    }
}
