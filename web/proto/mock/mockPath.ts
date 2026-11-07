/**
 * file:// 下的 URL 会保留盘符（`new URL('/api/x', 'file:///C:/a/b.html').pathname`
 * 是 `/C:/api/x`），模拟后端按 `/api/...` 匹配会落空。统一在这里去掉开头的 `/X:`。
 */
export function stripDriveLetter(pathname: string): string {
  return pathname.replace(/^\/[A-Za-z]:(?=\/)/, '');
}

/** 取 URL 的 pathname，已去盘符。 */
export function mockPathname(url: URL): string {
  return stripDriveLetter(url.pathname);
}
