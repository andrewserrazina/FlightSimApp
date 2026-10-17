/**
 * SimBrief `xml.fetcher.php?json=v2` transport shape: ONLY the parts Turnline reads.
 *
 * SimBrief converts its XML OFP to JSON, so every leaf is a string (numbers are numeric strings),
 * and an empty XML element can arrive as "", {} or be absent. Every field is therefore typed as
 * `unknown` and read through the guarded helpers in ./normalize.ts — nothing here is trusted.
 *
 * Field provenance (see docs/dispatch/simbrief-import.md):
 * - Documented: fetch.status, params.request_id, params.units, general.icao_airline,
 *   general.flight_number, general.initial_altitude, fuel.plan_ramp, weights.est_zfw,
 *   weights.payload, weights.pax_count, origin, destination, alternate (Navigraph docs and the
 *   Microsoft MSFS avionics SimbriefOfp type).
 * - Widely used by community integrations, to be confirmed against a real OFP: the remaining
 *   fuel/weights/times/aircraft fields. A field SimBrief does not send is shown as unavailable.
 */
type Leaf = unknown;

export interface SimbriefAirportRaw {
  icao_code?: Leaf;
  iata_code?: Leaf;
  name?: Leaf;
  plan_rwy?: Leaf;
  pos_lat?: Leaf;
  pos_long?: Leaf;
}

/**
 * One navlog record (S2-03). Field names and units confirmed against a real `json=v2` OFP:
 * distance = leg distance (nm), altitude_feet (ft), ind_airspeed/true_airspeed/groundspeed (kt),
 * time_leg/time_total (s or HH:MM:SS), fuel_* (OFP weight unit), pos_lat/pos_long (decimal deg).
 */
export interface SimbriefNavlogFixRaw {
  ident?: Leaf;
  name?: Leaf;
  type?: Leaf;
  pos_lat?: Leaf;
  pos_long?: Leaf;
  stage?: Leaf;
  via_airway?: Leaf;
  is_sid_star?: Leaf;
  distance?: Leaf;
  altitude_feet?: Leaf;
  ind_airspeed?: Leaf;
  true_airspeed?: Leaf;
  mach?: Leaf;
  groundspeed?: Leaf;
  time_leg?: Leaf;
  time_total?: Leaf;
  fuel_leg?: Leaf;
  fuel_totalused?: Leaf;
  fuel_plan_onboard?: Leaf;
  fuel_min_onboard?: Leaf;
}

export interface SimbriefOfpV2 {
  fetch?: { status?: Leaf; userid?: Leaf };
  params?: { request_id?: Leaf; user_id?: Leaf; time_generated?: Leaf; airac?: Leaf; units?: Leaf };
  general?: { icao_airline?: Leaf; flight_number?: Leaf; initial_altitude?: Leaf; costindex?: Leaf; route?: Leaf; air_distance?: Leaf; route_distance?: Leaf };
  /** Seen as an array of fixes in real OFPs; `{ fix: [...] }` in other integrations. */
  navlog?: SimbriefNavlogFixRaw[] | { fix?: SimbriefNavlogFixRaw[] | SimbriefNavlogFixRaw };
  atc?: { callsign?: Leaf };
  origin?: SimbriefAirportRaw;
  destination?: SimbriefAirportRaw;
  alternate?: SimbriefAirportRaw | SimbriefAirportRaw[];
  aircraft?: { icaocode?: Leaf; icao_code?: Leaf; name?: Leaf; reg?: Leaf };
  times?: {
    sched_out?: Leaf;
    sched_off?: Leaf;
    sched_on?: Leaf;
    sched_in?: Leaf;
    est_out?: Leaf;
    est_off?: Leaf;
    est_on?: Leaf;
    est_in?: Leaf;
    est_time_enroute?: Leaf;
    sched_time_enroute?: Leaf;
    sched_block?: Leaf;
    est_block?: Leaf;
  };
  fuel?: {
    plan_ramp?: Leaf;
    taxi?: Leaf;
    enroute_burn?: Leaf;
    contingency?: Leaf;
    alternate_burn?: Leaf;
    reserve?: Leaf;
    extra?: Leaf;
    min_takeoff?: Leaf;
    plan_takeoff?: Leaf;
    plan_landing?: Leaf;
  };
  weights?: { est_zfw?: Leaf; est_tow?: Leaf; est_ldw?: Leaf; payload?: Leaf; pax_count?: Leaf };
}
