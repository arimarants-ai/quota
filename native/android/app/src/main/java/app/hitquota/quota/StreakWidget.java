package app.hitquota.quota;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;

// The home-screen streak widget: the number, and whether today is in. From 10:15pm on a day
// still owed it shows the time left instead, counting down on its own.
public class StreakWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        RemoteViews v = views(c);
        for (int id : ids) m.updateAppWidget(id, v);
    }

    static void updateAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, StreakWidget.class));
        if (ids.length > 0) m.updateAppWidget(ids, views(c));
    }

    static RemoteViews views(Context c) {
        Today t = Today.read(c);
        long now = System.currentTimeMillis();
        boolean late = t.owing() && now >= Today.lastCall(now);
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_streak);
        v.setTextViewText(R.id.streak, String.valueOf(t.streak));
        v.setTextColor(R.id.streak, t.done ? 0xFF0B5A34 : 0xFF0B0C0E);
        String status = !t.signedIn ? "Open Quota" : !t.expected ? "Rest day" : t.done ? "Done today" : "Not posted yet";
        v.setTextViewText(R.id.status, status);
        v.setTextColor(R.id.status, t.done || !t.expected ? 0xFF0B5A34 : 0xFFE8590C);
        if (late) {
            long base = SystemClock.elapsedRealtime() + (Today.midnightAfter(now) - now);
            v.setChronometer(R.id.left, base, "%s left", true);
            v.setChronometerCountDown(R.id.left, true);
            v.setViewVisibility(R.id.left, View.VISIBLE);
            v.setViewVisibility(R.id.status, View.GONE);
        } else {
            v.setViewVisibility(R.id.left, View.GONE);
            v.setViewVisibility(R.id.status, View.VISIBLE);
        }
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(late ? "hitquota://record" : "hitquota://open"), c, MainActivity.class);
        v.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(c, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return v;
    }
}
