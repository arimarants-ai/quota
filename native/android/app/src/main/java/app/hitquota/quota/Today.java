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
    final String unit;        // what the streak counts: "day", or "week", "month" or "year"
    final boolean expected;   // a quota is due today
    final boolean done;
    final String left;
    final String crew;
    // Newer than the first widget. An app from before it sends no "posted", and the widget
    // then draws the way it always did.
    final boolean hasMoments;
    final boolean posted;     // anything posted towards any group today, a 0 included

    private Today(JSONObject o, Calendar now) {
        String today = day(now);
        boolean fresh = today.equals(o.optString("day"));
        signedIn = o.optBoolean("signedIn", false);
        streak = o.optInt("streak", 0);
        // An older app sends no unit, and every streak it knew was days.
        unit = o.optString("unit", "day").isEmpty() ? "day" : o.optString("unit", "day");
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
        hasMoments = o.has("posted");
        posted = fresh && o.optBoolean("posted", false);
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

    // 8pm: four hours before midnight, when the widget turns to its last hours.
    static long evening(long now) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(now);
        c.set(Calendar.HOUR_OF_DAY, 20); c.set(Calendar.MINUTE, 0); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    // The line of the day, and which of the fourteen pictures goes with it: the same for
    // everybody on the same date, all fourteen in turn. The page works it out the same way
    // (lineOfDay in index.html): the local date's day number since 1 January 1970, mod 14.
    static final String[] LINES = {
        "Consistency is key.", "Crush the day.", "Proof or it didn't happen.", "Today counts.", "One post. That's all.",
        "Your crew's watching.", "Small reps, big streak.", "Show up today.", "Done beats perfect.", "Future you says thanks.",
        "Easy day? Still counts.", "Keep it rolling.", "Breathe. Then go.", "You vs. yesterday.",
    };

    static int lineIndex(long now) {
        Calendar local = Calendar.getInstance();
        local.setTimeInMillis(now);
        Calendar utc = Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"));
        utc.clear();
        utc.set(local.get(Calendar.YEAR), local.get(Calendar.MONTH), local.get(Calendar.DAY_OF_MONTH));
        long n = Math.floorDiv(utc.getTimeInMillis(), 86_400_000L);
        return (int) (((n % 14) + 14) % 14);
    }

    // 10:15pm: an hour and three quarters before midnight.
    static long lastCall(long now) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(now);
        c.set(Calendar.HOUR_OF_DAY, 22); c.set(Calendar.MINUTE, 15); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }
}
