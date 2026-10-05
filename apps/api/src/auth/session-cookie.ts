export const SESSION_COOKIE = 'fl_session';

export interface CookieResponse {
  append(name: string, value: string): void;
}

export function setSessionCookie(
  response: CookieResponse,
  token: string,
  ttlSeconds: number,
  secure: boolean,
): void {
  response.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttlSeconds}${secure ? '; Secure' : ''}`,
  );
}

export function clearSessionCookie(
  response: CookieResponse,
  secure: boolean,
): void {
  response.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`,
  );
}
