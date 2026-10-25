// The engines the page can use: OpenBand's builtins, plus the OMEP engines the local server hosts
// (server/engines.mjs, reached through the bridge). The user's policy lives here too, per user (not per song).
import { create } from 'zustand';
import { engineRequest, useBridge } from '../bridge';
import { BUILTINS } from './builtin';
import { callRelay, relayEngines } from './relay';
import { DEFAULT_POLICY, type EngineInfo, type Policy } from './router';
import type { Capability, Contribution, Manifest, ToolInput } from './types';

const POLICY_KEY = 'openband.ensemble.policy';
function loadPolicy(): Policy {
  try {
    return { ...DEFAULT_POLICY, ...(JSON.parse(localStorage.getItem(POLICY_KEY) ?? '{}') as Partial<Policy>) };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export interface BrokenEngine {
  id: string;
  error: string;
}

export const useEnsemble = create<{ policy: Policy; external: EngineInfo[]; broken: BrokenEngine[]; checkedAt: number; checking: boolean; createOpen: boolean }>(() => ({
  policy: loadPolicy(),
  external: [],
  broken: [],
  checkedAt: 0,
  checking: false,
  createOpen: false,
}));

export function setPolicy(p: Partial<Policy>) {
  const policy = { ...useEnsemble.getState().policy, ...p };
  useEnsemble.setState({ policy });
  try {
    localStorage.setItem(POLICY_KEY, JSON.stringify(policy));
  } catch {
    // no storage
  }
  return policy;
}

export const builtinEngines = (): EngineInfo[] => BUILTINS.map((b) => ({ id: b.manifest.engine.id, manifest: b.manifest, transport: 'builtin', status: 'ready' }));

type Caller = (engine: string, capability: string, args: ToolInput) => Promise<Contribution>;
type Lister = () => Promise<{ id: string; status: string; manifest?: Manifest; error?: string; gpu?: EngineInfo['gpu'] }[]>;
let lister: Lister | null = null;
let caller: Caller | null = null;
/** For tests (and future transports): where external engines come from. */
export function setExternalEngines(list: Lister | null, call: Caller | null) {
  lister = list;
  caller = call;
  useEnsemble.setState({ external: [], broken: [], checkedAt: 0 });
}

const bridgeLister: Lister = () => engineRequest('list', {}, 60000);
const bridgeCaller: Caller = (engine, capability, args) => engineRequest<Contribution>('call', { engine, capability, args });

/** Ask the local server which engines are configured (at most every 10 s unless forced). */
export async function refreshEngines(force = false): Promise<EngineInfo[]> {
  const list = lister ?? (useBridge.getState().engines ? bridgeLister : null);
  if (!list) {
    useEnsemble.setState({ external: [], broken: [] });
    return [];
  }
  const st = useEnsemble.getState();
  if (!force && Date.now() - st.checkedAt < 10000) return st.external;
  useEnsemble.setState({ checking: true });
  try {
    const rows = await list();
    const external: EngineInfo[] = [];
    const broken: BrokenEngine[] = [];
    for (const r of rows) {
      if (r.status === 'ready' && r.manifest) external.push({ id: r.id, manifest: r.manifest, transport: 'bridge', status: 'ready', ...(r.gpu ? { gpu: r.gpu } : {}) });
      else broken.push({ id: r.id, error: r.error ?? 'not available' });
    }
    useEnsemble.setState({ external, broken, checkedAt: Date.now(), checking: false });
    return external;
  } catch (e) {
    useEnsemble.setState({ external: [], broken: [{ id: 'server', error: (e as Error).message }], checkedAt: Date.now(), checking: false });
    return [];
  }
}

export async function allEngines(): Promise<EngineInfo[]> {
  return [...builtinEngines(), ...(await refreshEngines()), ...relayEngines()];
}

export async function callEngine(e: EngineInfo, capability: Capability, input: ToolInput): Promise<Contribution> {
  if (e.transport === 'builtin') {
    const b = BUILTINS.find((x) => x.manifest.engine.id === e.id);
    if (!b) throw new Error(`Unknown builtin engine ${e.id}`);
    return b.run(capability, input);
  }
  if (e.transport === 'relay') return callRelay(e.id, capability, input);
  const call = caller ?? bridgeCaller;
  return call(e.id, capability, input);
}
