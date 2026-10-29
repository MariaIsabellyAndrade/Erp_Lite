export type UserRole = 'ADMIN' | 'EMPLOYEE';
export type SessionUser = { id: string; name: string; email: string; role: UserRole };

export function isAuthenticated(user: SessionUser | undefined): user is SessionUser {
  return Boolean(user?.id && user.email);
}

export function hasRole(user: SessionUser | undefined, role: UserRole): boolean {
  return isAuthenticated(user) && user.role === role;
}
