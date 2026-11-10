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

// The home-screen streak widget: the mascot art for the moment the day is at, the number,
// and one line. Morning (nothing posted yet) has the line of the day; partway, what is left;
// from 8pm on a day still owed, the time left, counting down on its own; done, and a rest day.
//
// A snapshot from an app older than the art has no "posted" in it, and then the widget draws
// the way it did before, from 10:15pm as it was.
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
        return t.hasMoments ? moments(c, t) : legacy(c, t);
    }

    static RemoteViews moments(Context c, Today t) {
        long now = System.currentTimeMillis();
        boolean lastHours = t.owing() && now >= Today.evening(now);
        boolean done = t.signedIn && t.done, rest = t.signedIn && !done && !t.expected;
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_moments);
        // Only the one picture this moment needs is put in the layout.
        v.setImageViewResource(R.id.art, done || rest ? R.drawable.mascot_done
                : lastHours ? R.drawable.mascot_lasthours
                : t.signedIn && t.posted ? R.drawable.mascot_partway : R.drawable.mascot_morning);
        String n = String.valueOf(t.streak);
        v.setTextViewText(R.id.streak, n);
        v.setTextViewText(R.id.streak_done, n);
        v.setTextViewText(R.id.unit, t.unit + " streak");
        // The colours are the layout's, light and dark, so they follow the phone's theme the
        // way the art does. Done is the green one, shown in place of the plain one.
        int numberShown = t.signedIn ? View.VISIBLE : View.GONE;
        v.setViewVisibility(R.id.streak, done ? View.GONE : numberShown);
        v.setViewVisibility(R.id.streak_done, done ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.unit, numberShown);
        v.setViewVisibility(R.id.line_done, done ? View.VISIBLE : View.GONE);
        if (lastHours) {
            long base = SystemClock.elapsedRealtime() + (Today.midnightAfter(now) - now);
            v.setChronometer(R.id.left, base, "%s left", true);
            v.setChronometerCountDown(R.id.left, true);
            v.setViewVisibility(R.id.left, View.VISIBLE);
            v.setViewVisibility(R.id.line, View.GONE);
        } else {
            v.setChronometer(R.id.left, SystemClock.elapsedRealtime(), null, false);
            v.setViewVisibility(R.id.left, View.GONE);
            String line = !t.signedIn ? "Open Quota" : rest ? "Rest day"
                    : t.posted ? (t.left.isEmpty() ? "Not done yet" : t.left + " left today")
                    : Today.LINES[Today.lineIndex(now)];
            v.setTextViewText(R.id.line, line);
            v.setViewVisibility(R.id.line, done ? View.GONE : View.VISIBLE);
        }
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(lastHours ? "hitquota://record" : "hitquota://open"), c, MainActivity.class);
        v.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(c, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return v;
    }

    // How the widget looked before the art, for a snapshot from an older app.
    static RemoteViews legacy(Context c, Today t) {
        long now = System.currentTimeMillis();
        boolean late = t.owing() && now >= Today.lastCall(now);
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_streak);
        v.setTextViewText(R.id.streak, String.valueOf(t.streak));
        v.setTextViewText(R.id.unit, t.unit + " streak");
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
