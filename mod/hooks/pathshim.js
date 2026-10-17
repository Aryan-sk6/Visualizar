// Stand-ins for the bits of node:path and model.js that translate.js uses.
const basename = (p) => {
  const s = String(p).replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
};
const dirname = (p) => {
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i);
};
const extname = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
};
export default { basename, dirname, extname };

export function clip(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
}
