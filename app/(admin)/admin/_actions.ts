'use server';

import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { appendAudit } from '@/lib/audit';

async function requireAdmin() {
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (session?.user.role !== 'admin') redirect('/admin?error=Unauthorized');
  return { h, adminId: session!.user.id };
}

function getIp(h: Awaited<ReturnType<typeof headers>>) {
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? undefined;
}

export async function createUserAction(formData: FormData) {
  const { h, adminId } = await requireAdmin();

  const email = (formData.get('email') as string)?.trim();
  const name = (formData.get('name') as string)?.trim();
  const password = formData.get('password') as string;
  const role = (formData.get('role') as string) || 'user';

  if (!email || !name || !password) {
    redirect('/admin?error=Email%2C+name%2C+and+password+are+required');
  }
  if (password.length < 8) {
    redirect('/admin?error=Password+must+be+at+least+8+characters');
  }

  let err: string | null = null;
  let newUserId: string | undefined;
  try {
    const result = await auth.api.createUser({ headers: h, body: { email, name, password, role: role as 'user' | 'admin' } });
    newUserId = (result as { user?: { id?: string } })?.user?.id;
  } catch (e: unknown) {
    err = e instanceof Error ? e.message : String(e);
  }
  if (err) redirect(`/admin?error=${encodeURIComponent(err)}`);

  appendAudit(db, { actor: adminId, action: 'user.create', targetType: 'user', targetId: newUserId, ip: getIp(h), metadata: { email, role } });
  revalidatePath('/admin');
  redirect(`/admin?success=${encodeURIComponent(`User ${email} created`)}`);
}

export async function setRoleAction(formData: FormData) {
  const { h, adminId } = await requireAdmin();
  const userId = formData.get('userId') as string;
  const role = formData.get('role') as string;

  let err: string | null = null;
  try {
    await auth.api.setRole({ headers: h, body: { userId, role: role as 'user' | 'admin' } });
  } catch (e: unknown) {
    err = e instanceof Error ? e.message : String(e);
  }
  if (err) redirect(`/admin?error=${encodeURIComponent(err)}`);

  appendAudit(db, { actor: adminId, action: 'user.role_change', targetType: 'user', targetId: userId, ip: getIp(h), metadata: { newRole: role } });
  revalidatePath('/admin');
  redirect('/admin?success=Role+updated');
}

export async function banUserAction(formData: FormData) {
  const { h, adminId } = await requireAdmin();
  const userId = formData.get('userId') as string;
  const banReason = ((formData.get('banReason') as string) || '').trim() || 'Banned by admin';

  let err: string | null = null;
  try {
    await auth.api.banUser({ headers: h, body: { userId, banReason } });
  } catch (e: unknown) {
    err = e instanceof Error ? e.message : String(e);
  }
  if (err) redirect(`/admin?error=${encodeURIComponent(err)}`);

  appendAudit(db, { actor: adminId, action: 'user.disable', targetType: 'user', targetId: userId, ip: getIp(h) });
  revalidatePath('/admin');
  redirect('/admin?success=User+banned');
}

export async function unbanUserAction(formData: FormData) {
  const { h, adminId } = await requireAdmin();
  const userId = formData.get('userId') as string;

  let err: string | null = null;
  try {
    await auth.api.unbanUser({ headers: h, body: { userId } });
  } catch (e: unknown) {
    err = e instanceof Error ? e.message : String(e);
  }
  if (err) redirect(`/admin?error=${encodeURIComponent(err)}`);

  appendAudit(db, { actor: adminId, action: 'user.enable', targetType: 'user', targetId: userId, ip: getIp(h) });
  revalidatePath('/admin');
  redirect('/admin?success=User+unbanned');
}

export async function resetPasswordAction(formData: FormData) {
  const { h, adminId } = await requireAdmin();
  const userId = formData.get('userId') as string;
  const newPassword = formData.get('newPassword') as string;

  if (!newPassword || newPassword.length < 8) {
    redirect('/admin?error=Password+must+be+at+least+8+characters');
  }

  let err: string | null = null;
  try {
    await auth.api.setUserPassword({ headers: h, body: { userId, newPassword } });
  } catch (e: unknown) {
    err = e instanceof Error ? e.message : String(e);
  }
  if (err) redirect(`/admin?error=${encodeURIComponent(err)}`);

  appendAudit(db, { actor: adminId, action: 'user.password_reset', targetType: 'user', targetId: userId, ip: getIp(h) });
  revalidatePath('/admin');
  redirect('/admin?success=Password+reset');
}

export async function removeUserAction(formData: FormData) {
  const { h, adminId } = await requireAdmin();
  const userId = formData.get('userId') as string;
  const confirm = formData.get('confirm') as string;

  if (confirm !== 'DELETE') {
    redirect('/admin?error=Type+DELETE+to+confirm+deletion');
  }

  let err: string | null = null;
  try {
    await auth.api.removeUser({ headers: h, body: { userId } });
  } catch (e: unknown) {
    err = e instanceof Error ? e.message : String(e);
  }
  if (err) redirect(`/admin?error=${encodeURIComponent(err)}`);

  appendAudit(db, { actor: adminId, action: 'user.delete', targetType: 'user', targetId: userId, ip: getIp(h) });
  revalidatePath('/admin');
  redirect('/admin?success=User+deleted');
}
