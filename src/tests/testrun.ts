// ?testrun=<port>: `openband test` drives the studio headless. Read the song from it, run, post back.
import { readProjectFile } from '../importers';
import { commands } from '../commands';
import { ensureSamples } from '../audio/samples';
import { useStore, projectSampleIds } from '../store';

export async function testRun(port: string) {
  const back = (body: unknown) => fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', body: JSON.stringify(body) });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/song`);
    const project = await readProjectFile(await r.arrayBuffer());
    useStore.getState().loadProject(project);
    await ensureSamples(projectSampleIds(useStore.getState().project));
    const run = (await commands.run_tests({ baseline: r.headers.get('x-baseline') ?? undefined })) as { results: unknown[] };
    await back({ results: run.results });
  } catch (e) {
    await back({ error: (e as Error).message });
  }
}
