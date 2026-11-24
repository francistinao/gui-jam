import { cancel, intro, outro } from '@clack/prompts';
import { type FetchTags, fetchDistTags, newestFor } from '@guijam/vite-plugin/update-check';
import { detectProject } from './detect.js';
import { installGuijam, messageOf } from './init.js';

export interface UpdateOptions {
  cwd: string;
  version: string;
  fetchTags?: FetchTags;
}

export async function update({
  cwd,
  version,
  fetchTags = fetchDistTags,
}: UpdateOptions): Promise<number> {
  intro('Update GUIJam');
  if (version === '0.0.0') {
    outro("This guijam is a local build, so there's nothing to update from npm.");
    return 0;
  }
  try {
    const project = detectProject(cwd);
    if (!project.hasGuijam) {
      cancel("guijam isn't in this project's package.json. Run npx guijam init to set it up.");
      return 1;
    }
    const tags = await fetchTags().catch((error: unknown) => {
      throw new Error(`Couldn't reach npm to check for a newer guijam: ${messageOf(error)}`);
    });
    const newest = newestFor(version, tags);
    if (!newest) {
      outro(`guijam ${version} is the newest version.`);
      return 0;
    }
    await installGuijam(project, `guijam@${newest}`);
    outro(`Updated guijam to ${newest}. Restart the dev server to use it.`);
    return 0;
  } catch (error) {
    cancel(messageOf(error));
    return 1;
  }
}
