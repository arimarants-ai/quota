package app.hitquota.quota;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;

// One motivational picture and its line a day, all fourteen in turn, with the streak under it.
// It changes at midnight, when the midnight alarm updates it, and whenever the app says more.
public class MotivationWidget extends AppWidgetProvider {
    private static final int[] ART = {
        R.drawable.mascot_motivation_01, R.drawable.mascot_motivation_02, R.drawable.mascot_motivation_03,
        R.drawable.mascot_motivation_04, R.drawable.mascot_motivation_05, R.drawable.mascot_motivation_06,
        R.drawable.mascot_motivation_07, R.drawable.mascot_motivation_08, R.drawable.mascot_motivation_09,
        R.drawable.mascot_motivation_10, R.drawable.mascot_motivation_11, R.drawable.mascot_motivation_12,
        R.drawable.mascot_motivation_13, R.drawable.mascot_motivation_14,
    };

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        RemoteViews v = views(c);
        for (int id : ids) m.updateAppWidget(id, v);
    }

    static void updateAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        int[] ids = m.getAppWidgetIds(new ComponentName(c, MotivationWidget.class));
        if (ids.length > 0) m.updateAppWidget(ids, views(c));
    }

    static RemoteViews views(Context c) {
        Today t = Today.read(c);
        int i = Today.lineIndex(System.currentTimeMillis());
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_motivation);
        v.setImageViewResource(R.id.art, ART[i]);
        v.setTextViewText(R.id.line, Today.LINES[i]);
        v.setTextViewText(R.id.unit, t.streak + " " + t.unit + " streak");
        v.setViewVisibility(R.id.unit, t.signedIn ? View.VISIBLE : View.GONE);
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse("hitquota://open"), c, MainActivity.class);
        v.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(c, 2, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return v;
    }
}
