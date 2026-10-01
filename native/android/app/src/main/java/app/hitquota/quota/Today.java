package app.hitquota.quota;

import android.content.Context;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

// What the app last said about today, kept on the phone for the widget and the alarm.
final class Today {
    private static final String PREFS = "quota";
    private static final String KEY = "widget";

    final boolean signedIn;
    final int streak;
    final boolean expected;   // a quota is due today
    final boolean done;
    final String left;
    final String crew;

    private Today(JSONObject o, Calendar now) {
        String today = day(now);
        boolean fresh = today.equals(o.optString("day"));
        signedIn = o.optBoolean("signedIn", false);
        streak = o.optInt("streak", 0);
        if (fresh) {
            expected = o.optBoolean("due", true);
        } else {
            // A day the app has not been opened on yet: the week's pattern says whether it counts.
            JSONArray days = o.optJSONArray("dueDays");
            boolean on = days == null || days.length() == 0;
            int dow = now.get(Calendar.DAY_OF_WEEK) - 1;   // 0 is Sunday, as on the page
            for (int i = 0; days != null && i < days.length(); i++) if (days.optInt(i, -1) == dow) on = true;
            expected = on;
        }
        done = fresh && o.optBoolean("done", false);
        left = fresh ? o.optString("left", "") : "";
        crew = fresh ? o.optString("crew", "") : "";
    }

    static void save(Context c, String json) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply();
    }

    static Today read(Context c) {
        String s = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "{}");
        JSONObject o;
        try { o = new JSONObject(s); } catch (Exception e) { o = new JSONObject(); }
        return new Today(o, Calendar.getInstance());
    }

    boolean owing() { return signedIn && expected && !done; }

    static String day(Calendar c) {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(c.getTime());
    }

    static long midnightAfter(long now) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(now);
        c.add(Calendar.DAY_OF_YEAR, 1);
        c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    // 10:15pm: an hour and three quarters before midnight.
    static long lastCall(long now) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(now);
        c.set(Calendar.HOUR_OF_DAY, 22); c.set(Calendar.MINUTE, 15); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }
}
