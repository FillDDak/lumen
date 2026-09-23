/* LUMEN — small vector / matrix helpers (column-major, WebGL style) */
(function (L) {
  'use strict';

  const V = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm(a) {
      const l = Math.hypot(a[0], a[1], a[2]) || 1;
      return [a[0] / l, a[1] / l, a[2] / l];
    },
  };

  const M = {
    perspective(out, fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2);
      const nf = 1 / (near - far);
      out.fill(0);
      out[0] = f / aspect;
      out[5] = f;
      out[10] = (far + near) * nf;
      out[11] = -1;
      out[14] = 2 * far * near * nf;
      return out;
    },
    // Returns the view matrix plus the camera basis (useful for picking rays).
    lookAt(out, eye, center, up) {
      const z = V.norm(V.sub(eye, center));
      const x = V.norm(V.cross(up, z));
      const y = V.cross(z, x);
      out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
      out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
      out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
      out[12] = -V.dot(x, eye);
      out[13] = -V.dot(y, eye);
      out[14] = -V.dot(z, eye);
      out[15] = 1;
      return { right: x, up: y, forward: [-z[0], -z[1], -z[2]] };
    },
  };

  const U = {
    clamp: (x, a, b) => Math.min(b, Math.max(a, x)),
    lerp: (a, b, t) => a + (b - a) * t,
    // frame-rate independent smoothing factor
    damp: (rate, dt) => 1 - Math.exp(-rate * dt),
  };

  L.V = V;
  L.M = M;
  L.U = U;
})(window.LUMEN = window.LUMEN || {});
