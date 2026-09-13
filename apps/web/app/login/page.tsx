import { redirect } from 'next/navigation';
import { Mark } from '@/components/mark';
import { currentSession } from '@/lib/auth/session';
import { accountState } from '@/lib/auth/account';
import { LoginForm } from './_components/login-form';

export default async function LoginPage() {
  if (await currentSession()) redirect('/');
  const setup = accountState();

  return (
    <main className="signin">
      <div className="signin-panel">
        <div className="brand"><Mark /><span>Taskly</span></div>
        <div className="signin-form">
          <div>
            <div className="eyebrow">Marketing OS</div>
            <h1>Ask the market.</h1>
            <p className="lede">Every figure with the sentence it came from, on a page we actually fetched.</p>
          </div>
          {setup === 'needs-setup' ? (
            <div className="alert">Sign-in isn’t set up yet. Set <b>TMOS_CONSOLE_PASSWORD</b> (12+ characters) on the server, then reload.</div>
          ) : (
            <LoginForm />
          )}
        </div>
      </div>
      <div className="signin-photo">
        <img src="/login.jpg" alt="A Toronto front door at blue hour, warm light spilling out" />
        <div className="cap">Taskly anything. Consider it done.</div>
      </div>
    </main>
  );
}
