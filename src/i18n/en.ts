/**
 * Every user-facing string in the app, in English.
 *
 * This is the source of truth: `dv.ts` is generated from it by
 * `scripts/translate-dv.ts`, and is typed against it, so a key added here
 * fails the build until it has been translated.
 *
 * Values are plain strings — no functions — so the translation script can
 * import this file directly. Interpolation is `{name}` tokens, filled in by
 * `t(key, params)`; a translation must keep every token its English source has.
 *
 * English needs two forms where Dhivehi may only need one (`stopsOne` /
 * `stopsMany`), so plurals are separate keys rather than an inline `s`.
 */
export const en = {
  // ---- Chrome ----------------------------------------------------------
  region: 'Greater Malé',
  offline: "Offline — using today's saved timetable. No live bus times.",
  loadingRoutes: 'Loading bus routes…',
  recentre: 'Recentre',
  close: 'Close',
  tryAgain: 'Try again',
  fatalTitle: 'Can’t reach the bus service',
  fatalPortHint:
    "RTL's API is served on port 4455, which some networks block. If you're on hotel or office Wi-Fi, try mobile data.",
  apiUnreachable: 'Could not reach the RTL bus service. Check your connection and try again.',

  // ---- Language picker -------------------------------------------------
  languageLabel: 'Language',
  languageBoth: 'English + ދިވެހި',
  languageEn: 'English',
  languageDv: 'ދިވެހި',

  // ---- Home ------------------------------------------------------------
  fieldFrom: 'From',
  fieldTo: 'To',
  locating: 'Finding your location…',
  chooseStart: 'Choose a start',
  whereAreYouGoing: 'Where are you going?',
  locationBlocked: 'Location blocked — tap to retry',
  useMyLocation: 'Use my location',
  headingSaved: 'Saved',
  manage: 'Manage',
  headingRecent: 'Recent',
  fromPlace: 'from {name}',
  myLocation: 'My location',

  // ---- Search ----------------------------------------------------------
  searchFrom: 'Where from?',
  searchTo: 'Where to?',
  searchSave: 'Save a place',
  closeSearch: 'Close search',
  clear: 'Clear',
  headingNearbyStops: 'Nearby stops',
  headingBusStops: 'Bus stops',
  headingPlaces: 'Places',
  searching: 'Searching…',
  noPlacesFound: 'No places found. Try a bus stop name instead.',
  searchPrompt: 'Search for a bus stop, a landmark or an address in Greater Malé.',

  // ---- Results ---------------------------------------------------------
  saveThisPlace: 'Save this place',
  removeFromSaved: 'Remove from saved places',
  noRouteFound: 'No bus route found for this trip.',
  noRouteHint:
    'RTL buses cover Malé, Hulhulé and Hulhumalé, plus Villimalé internally. Villimalé is reached by ferry, not by bus, so trips between it and Malé cannot be planned here.',
  walkPreference: 'Walking preference',
  walkLess: 'Less walking',
  walkLessHint: 'Favours trips with the shortest walk',
  walkBalanced: 'Balanced',
  walkBalancedHint: 'Trades walking against time and fare',
  walkMore: 'Fastest',
  walkMoreHint: 'Walk further if it gets you there sooner',

  // ---- Itineraries -----------------------------------------------------
  direct: 'Direct',
  walkWholeWay: 'Walk the whole way',
  transfersOne: '{n} transfer',
  transfersMany: '{n} transfers',
  distanceTotal: '{dist} total',
  distanceWalking: '{dist} walking',
  distanceWalk: '{dist} walk',
  arrivingNow: 'Arriving now',
  nextIn: 'Next in {n} min',
  estimated: 'Estimated',
  estimatedTitle:
    'This route has no published timetable, so times are estimated from typical frequency.',
  estimatedNotice:
    'This trip uses a minibus route with no published timetable. Times are estimated from typical frequency, so treat them as a guide.',
  checkingLive: 'Checking for live bus times…',
  allOptions: 'All options',
  startJourney: 'Start journey',
  startJourneyHint: 'Step-by-step directions that follow you as you go',

  // ---- Leg timeline ----------------------------------------------------
  walkTo: 'Walk to {name}',
  distanceAbout: '{dist} · about {duration}',
  board: 'Board',
  getOff: 'Get off',
  stopsOne: '{n} stop',
  stopsMany: '{n} stops',
  legSummary: '{stops} · {dist} · {duration}',
  busNumbered: 'bus {code}',
  noTimetableEstimated: 'No published timetable — estimated',

  // ---- Stop detail -----------------------------------------------------
  stopCode: 'Stop {code}',
  startHere: 'Start here',
  goHere: 'Go here',
  nextBuses: 'Next buses',
  checkingArrivals: 'Checking live arrivals…',
  noArrivals: 'No live arrivals reported for this stop right now.',
  towards: 'towards {name}',
  now: 'Now',
  routesServingStop: 'Routes serving this stop',

  // ---- Saved places ----------------------------------------------------
  savedPlaces: 'Saved places',
  addAPlace: '+ Add a place',
  savedEmpty:
    'Save the places you travel to often — they show up on the home screen and at the top of search. Saved places stay on this device.',
  edit: 'Edit',
  namePlaceholder: 'Name',
  delete: 'Delete',
  cancel: 'Cancel',
  save: 'Save',

  // ---- Journey navigation ----------------------------------------------
  endJourney: 'End journey',
  stepOfTotal: 'Step {n} of {total}',
  arrivingAt: 'Arriving {time}',
  anyMoment: 'any moment',
  timeToGo: '{duration} to go',
  timeElapsed: '{duration} in',
  then: 'Then',
  wentTooFar: 'Went too far? Back a step',
  reachedDestination: 'You have reached your destination',
  tookDuration: 'Took {duration}',
  distanceTravelled: '{dist} travelled',
  distanceWalked: '{dist} walked',
  fareTotal: '{fare} fare',
  eyebrowWalk: 'Walk',
  youreThere: "You're there. Moving you on…",
  eyebrowAtStop: 'At the stop',
  waitForRoute: 'Wait for {route}',
  atStop: 'at {name}',
  aroundTime: 'Around {time}',
  departsTime: 'Departs {time}',
  arrivesTime: 'Arrives {time}',
  getOffAt: 'Get off at {name}',
  busPullingIn: 'Your bus is pulling in — board it',
  noLivePosition: 'No live position for this bus — go by the timetable.',
  eyebrowOnRoute: 'On the {route}',
  rideTo: 'Ride to {name}',
  getOffHere: '{name} — get off here',
  approachingAlight: 'Get off at the next stop — {name} is {dist} ahead',
  gettingOffHere: 'Getting off here',
  stopsToGoOne: '{n} stop to go',
  stopsToGoMany: '{n} stops to go',
  untrackableBus:
    'Nothing reliable to track this bus by, so count the stops yourself and tap below when you get off.',
  followingBus: 'Following bus {code}',
  youAreHere: 'you are here',
  distanceAway: '{dist} away',
  locationOff: 'Location off, so tap the button below when you get there.',
  actionImHere: "I'm here",
  actionBoarded: "I've boarded",
  actionGotOff: "I've got off",
  actionDone: 'Done',
  summaryWalk: 'walk to {name}',
  summaryWait: 'wait for {route} at {name}',
  summaryRide: 'ride {route} to {name}',
  summaryArrive: 'arrive at your destination',

  // ---- Live bus popup --------------------------------------------------
  unmarkedBus: 'Unmarked bus',
  directionUnknown: 'Direction not known yet',
  stopped: 'Stopped',
  lastHeaded: '— last headed {direction}',
  headingTowards: 'Heading {direction}',
  headingTowardsAtSpeed: 'Heading {direction} · {speed}',
  updatedAndMoved: 'Updated {updated} · moved {moved}',
  positionOnlyNote: 'RTL reports position only — direction appears once the bus has moved.',
  inferredMotionNote: 'Direction and speed are estimated from recent positions.',

  // ---- Live ETA labels -------------------------------------------------
  etaArriving: 'Arriving',
  etaDispatch: 'Departs terminal in {n} min',
  etaMinutes: '{n} min',

  // ---- Units and formatting --------------------------------------------
  fare: 'MVR {amount}',
  durationMinutes: '{n} min',
  durationHours: '{n} hr',
  durationHoursMinutes: '{h} hr {m} min',
  agoJustNow: 'just now',
  agoSeconds: '{n}s ago',
  agoMinutes: '{n} min ago',
  agoHours: '{n} hr ago',
  distanceMetres: '{n} m',
  distanceKilometres: '{n} km',
  speedKmh: '{n} km/h',

  // ---- Compass ---------------------------------------------------------
  compassNorth: 'north',
  compassNorthEast: 'north-east',
  compassEast: 'east',
  compassSouthEast: 'south-east',
  compassSouth: 'south',
  compassSouthWest: 'south-west',
  compassWest: 'west',
  compassNorthWest: 'north-west',
};
