// Classify how a WebRTC connection actually runs, so the UI can tell the user
// whether traffic is direct or transits a TURN relay.
//
//   direct-host : both ends on the same network / no NAT — peers see each
//                 other's real IP
//   direct-srflx: NAT-traversed direct connection — peers see each other's
//                 public IP
//   turn-relay  : traffic flows through a TURN server, which sees both IPs
//                 and the (DTLS-encrypted) packet stream
//   unknown     : stats unavailable or no succeeded candidate pair yet

export type ConnectionType = 'direct-host' | 'direct-srflx' | 'turn-relay' | 'unknown';

export async function classifyConnection(pc: { getStats(): Promise<unknown> }): Promise<ConnectionType> {
  try {
    const stats = await pc.getStats();
    const reports = new Map<string, Record<string, unknown>>();
    (stats as { forEach(cb: (r: Record<string, unknown>) => void): void })
      .forEach(r => reports.set(r.id as string, r));

    let pair: Record<string, unknown> | undefined;
    for (const r of reports.values()) {
      if (r.type === 'candidate-pair' && (r.state === 'succeeded' || r.selected === true) && r.nominated !== false) {
        pair = r;
        if (r.selected === true) break;
      }
    }
    if (!pair) return 'unknown';

    const local = reports.get(pair.localCandidateId as string);
    const remote = reports.get(pair.remoteCandidateId as string);
    const types = [local?.candidateType, remote?.candidateType];
    if (types.includes('relay')) return 'turn-relay';
    if (types.includes('srflx') || types.includes('prflx')) return 'direct-srflx';
    if (local?.candidateType === 'host') return 'direct-host';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
