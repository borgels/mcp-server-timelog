/**
 * Our own fixed texts for a call refused because of whom it is made for (the host's actAs). They never hold the email
 * or TimeLog's text, and a host may recognise them by their exact words.
 */

/** A period read for a person who is not the key's user: TimeLog's period reads have no user parameter. */
export const OWN_TIME_ONLY =
  "Refused: TimeLog's API reads time only for the key's own user, and the person is another user; nothing was read.";

/** A task or project created for a person who is not the key's user: TimeLog records the key's user as the creator. */
export const CREATED_BY_KEY_USER_ONLY =
  "Refused: TimeLog records the key's own user as the creator of a task or project, and the person is another user; nothing was created.";

/** A registration that is not the person's own (get_time_registration, update_time). */
export const NOT_OWN_REGISTRATION = "Refused: the time registration is not the person's own; nothing was read or changed.";

/** register_time for another employee while acting as a person. */
export const OTHER_EMPLOYEE =
  'Refused: acting as a person, time is registered for that person only; leave out employeeId. Nothing was sent.';
