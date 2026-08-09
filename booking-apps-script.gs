/**
 * North Sound Studio - booking backend
 * ---------------------------------------------------------------
 * This is what stops two people from grabbing the same time slot.
 * It reads your Google Calendar to see what is already taken, and it
 * writes the booking onto your calendar when someone picks a time.
 *
 * SETUP (about five minutes, once)
 *
 *  1. Go to script.google.com and click New project.
 *  2. Delete whatever is in the editor. Paste this entire file in.
 *  3. Click the gear (Project Settings) on the left. Check that the
 *     timezone says (GMT-08:00) Pacific Time. Fix it if it does not.
 *  4. Back in the editor, click Deploy > New deployment.
 *  5. Click the gear next to "Select type" and choose Web app.
 *  6. Set:
 *       Execute as:        Me (your gmail address)
 *       Who has access:    Anyone
 *     "Anyone" is required. Visitors are not signed in to Google, so
 *     anything stricter blocks the website. They still cannot see your
 *     calendar, only the busy/free answer this script gives them.
 *  7. Click Deploy. Google asks you to authorize it. Click through the
 *     "unverified app" warning by choosing Advanced > Go to project.
 *     It is your own script, that warning is normal.
 *  8. Copy the Web app URL it gives you. It ends in /exec.
 *  9. Send me that URL, or paste it into index.html yourself: search
 *     for BOOKING_API and put it between the quotes.
 *
 * AFTER ANY EDIT TO THIS FILE
 *   Deploy > Manage deployments > pencil icon > Version: New version >
 *   Deploy. Editing alone does not update the live URL.
 */

var CONFIG = {
  // 'primary' is your main Google Calendar. To use a different one,
  // put its calendar ID here (Calendar settings > Integrate calendar).
  CALENDAR_ID: 'primary',

  // Hours a call may start, 24 hour clock. 13 = 1pm.
  WEEKDAY_HOURS:  [9, 10, 11, 13, 14, 15, 16, 17],
  SATURDAY_HOURS: [10, 11, 12],
  SUNDAY_HOURS:   [],

  CALL_MINUTES: 15,    // how long the call is
  LEAD_HOURS:   2,     // shortest notice you will accept
  WINDOW_DAYS:  60,    // how far ahead people may book

  // true  = all day events (birthdays, "Vacation") do not block slots
  // false = an all day event blocks the whole day
  IGNORE_ALL_DAY: true,

  // Where the heads up email goes. Blank string turns it off.
  NOTIFY: 'northsoundstudio1@gmail.com'
};

/** The website calls this. Reads are plain GETs, bookings pass action=book. */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;

  try {
    out = p.action === 'book'
      ? book(p)
      : { ok: true, tz: tz(), busy: busyMap() };
  } catch (err) {
    out = { ok: false, reason: 'error', message: String((err && err.message) || err) };
  }

  var body = JSON.stringify(out);

  // JSONP, because a plain fetch from your domain to Google trips CORS
  if (p.callback && /^[A-Za-z0-9_$.]{1,64}$/.test(p.callback)) {
    return ContentService
      .createTextOutput(p.callback + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function tz() {
  return Session.getScriptTimeZone();
}

function calendar() {
  return CONFIG.CALENDAR_ID === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
}

function hoursForDow(dow) {
  if (dow === 0) return CONFIG.SUNDAY_HOURS;
  if (dow === 6) return CONFIG.SATURDAY_HOURS;
  return CONFIG.WEEKDAY_HOURS;
}

/** Builds a Date at a wall clock hour on a given day, in the script timezone. */
function slotStart(day, hour) {
  var p = day.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), hour, 0, 0, 0);
}

/**
 * Which hours are already spoken for, as { '2026-08-14': [11, 13] }.
 * An hour counts as taken if any event touches it at all, so a 10:30
 * dentist appointment closes the 10:00 slot rather than crowding it.
 */
function busyMap() {
  var now = new Date();
  var end = new Date(now.getTime() + CONFIG.WINDOW_DAYS * 86400000);
  var seen = {};

  calendar().getEvents(now, end).forEach(function (ev) {
    if (CONFIG.IGNORE_ALL_DAY && ev.isAllDayEvent()) return;

    var stop = ev.getEndTime().getTime();
    for (var t = ev.getStartTime().getTime(); t < stop; t += 1800000) {
      var at = new Date(t);
      var day = Utilities.formatDate(at, tz(), 'yyyy-MM-dd');
      var hour = Number(Utilities.formatDate(at, tz(), 'H'));
      if (!seen[day]) seen[day] = {};
      seen[day][hour] = true;
    }
  });

  var out = {};
  Object.keys(seen).forEach(function (day) {
    out[day] = Object.keys(seen[day]).map(Number).sort(function (a, b) { return a - b; });
  });
  return out;
}

/** Is this slot one you actually offer, and still far enough out? */
function isOpen(day, hour) {
  var start = slotStart(day, hour);
  if (hoursForDow(start.getDay()).indexOf(hour) === -1) return false;

  var ms = start.getTime();
  if (ms < Date.now() + CONFIG.LEAD_HOURS * 3600000) return false;
  if (ms > Date.now() + CONFIG.WINDOW_DAYS * 86400000) return false;
  return true;
}

/**
 * Takes a slot. The lock is the whole point: two people submitting at the
 * same moment get serialized, so the second one is told the time is gone
 * instead of quietly double booking you.
 */
function book(p) {
  var day   = String(p.day || '');
  var hour  = Number(p.hour);
  var name  = String(p.name  || '').trim().slice(0, 120);
  var email = String(p.email || '').trim().slice(0, 160);
  var phone = String(p.phone || '').trim().slice(0, 60);
  var about = String(p.about || '').trim().slice(0, 500);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !(hour >= 0 && hour <= 23)) {
    return { ok: false, reason: 'error', message: 'That time did not look right.' };
  }
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, reason: 'error', message: 'Name and a real email are required.' };
  }
  if (!isOpen(day, hour)) return { ok: false, reason: 'closed' };

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return { ok: false, reason: 'busy' };
  }

  try {
    var taken = busyMap()[day];
    if (taken && taken.indexOf(hour) !== -1) return { ok: false, reason: 'taken' };

    var start = slotStart(day, hour);
    var end   = new Date(start.getTime() + CONFIG.CALL_MINUTES * 60000);
    var when  = Utilities.formatDate(start, tz(), "EEEE, MMMM d 'at' h:mm a");

    calendar().createEvent('Intro call: ' + name, start, end, {
      description: [
        'Booked from northsoundstudio.com',
        '',
        'Name:  ' + name,
        'Email: ' + email,
        'Phone: ' + (phone || 'not given'),
        'About: ' + (about || 'not given')
      ].join('\n'),
      guests: email,
      sendInvites: true
    });

    if (CONFIG.NOTIFY) {
      MailApp.sendEmail({
        to: CONFIG.NOTIFY,
        replyTo: email,
        subject: 'Call booked: ' + when,
        body: [
          name + ' booked ' + when + '.',
          '',
          'Email: ' + email,
          'Phone: ' + (phone || 'not given'),
          'About: ' + (about || 'not given'),
          '',
          'It is on your calendar and they have the invite.'
        ].join('\n')
      });
    }

    return { ok: true, when: when };
  } finally {
    lock.releaseLock();
  }
}

/** Run this from the editor once to check the calendar wiring. */
function testSetup() {
  var busy = busyMap();
  Logger.log('Timezone: %s', tz());
  Logger.log('Calendar: %s', calendar().getName());
  Logger.log('Days with something on them in the next %s: %s',
    CONFIG.WINDOW_DAYS, Object.keys(busy).length);
  Logger.log(JSON.stringify(busy, null, 2));
}
