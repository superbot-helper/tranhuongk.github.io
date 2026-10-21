// Entry of the web viewer page. In `vite dev` only, `?fake` swaps the relay for a local demo
// session (no network, no credentials) so the UI can be exercised without a Windows machine;
// the production build drops that branch and its module entirely (the demo needs no crypto, so it
// also works on http://<LAN-IP>; the real session does not and is refused there).
import { WORKER_URL } from '../config';
import { resolveIPv4 } from '../net/dns';
import { RelaySession } from '../session/relay-session';
import { workerChannelOpener } from '../session/worker-channel';
import './fonts.css';
import { insecureContextNotice } from './secure-context';
import { mountViewer, type ViewerDeps } from './viewer';

const realSession: ViewerDeps['createSession'] = ({ workerUrl }) =>
  new RelaySession({
    openChannel: workerChannelOpener({ workerUrl }),
    resolve: resolveIPv4,
    now: () => performance.now(),
  });

function start(createSession: ViewerDeps['createSession'], insecureNotice: string | null): void {
  const app = document.getElementById('app');
  if (app) mountViewer(app, { createSession, workerUrl: WORKER_URL, insecureNotice });
}

if (import.meta.env.DEV && new URLSearchParams(location.search).has('fake')) {
  void import('./dev-fake-session').then((m) => start(m.createDevFakeSession(new URLSearchParams(location.search)), null));
} else {
  start(realSession, insecureContextNotice());
}
