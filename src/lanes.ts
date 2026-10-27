// No Node imports: the web page uses this too.
const LANE_ORDER = (lane: string) => (lane === 'fireline' ? 0 : lane === 'other' ? 2 : 1);

export function sortLanes(lanes: string[]): string[] {
  return [...lanes].sort((a, b) => LANE_ORDER(a) - LANE_ORDER(b) || a.localeCompare(b));
}
