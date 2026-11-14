import { useAccessSession } from '../src/access-session';

export default function Index() {
  return useAccessSession().signedOut;
}
