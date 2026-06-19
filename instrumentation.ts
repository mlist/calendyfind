// Runs once on Next.js server startup (both dev and prod).
// Validates ENCRYPTION_KEY, applies pending Drizzle migrations, seeds the first
// admin user from env (if ADMIN_EMAIL + ADMIN_PASSWORD are set and no user exists
// with that email yet), then starts the reminder scheduler.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEncryptionKey } = await import('./lib/crypto');
    validateEncryptionKey();

    const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
    const { db } = await import('./lib/db/index');
    const { resolve } = await import('path');

    migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });

    // Auto-seed the admin account so no separate seed step is needed in Docker.
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (adminEmail && adminPassword) {
      const { user: userTable } = await import('./lib/db/schema');
      const { eq } = await import('drizzle-orm');
      const existing = db
        .select({ id: userTable.id })
        .from(userTable)
        .where(eq(userTable.email, adminEmail))
        .limit(1)
        .all();
      if (existing.length === 0) {
        const { betterAuth } = await import('better-auth');
        const { drizzleAdapter } = await import('better-auth/adapters/drizzle');
        const schema = await import('./lib/db/schema');
        const seedAuth = betterAuth({
          secret: process.env.BETTER_AUTH_SECRET ?? 'seed-secret',
          baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
          database: drizzleAdapter(db, { provider: 'sqlite', schema }),
          emailAndPassword: { enabled: true, disableSignUp: false },
        });
        await seedAuth.api.signUpEmail({
          body: { email: adminEmail, password: adminPassword, name: 'Admin' },
        });
        db.update(userTable).set({ role: 'admin' }).where(eq(userTable.email, adminEmail)).run();
        console.log(`[startup] Admin created: ${adminEmail}`);
      }
    }

    const { startReminderScheduler } = await import('./lib/reminders/scheduler');
    startReminderScheduler();
  }
}
