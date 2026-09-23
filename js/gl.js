/* LUMEN — thin WebGL2 helpers */
(function (L) {
  'use strict';

  function compile(gl, type, src, name) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      const numbered = src.split('\n').map((l, i) => String(i + 1).padStart(4) + ' ' + l).join('\n');
      console.error(`[${name}] shader compile error\n${log}\n${numbered}`);
      throw new Error(`Shader compile failed: ${name}: ${log}`);
    }
    return sh;
  }

  function program(gl, vsSrc, fsSrc, name) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc, name + '.vs'));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc, name + '.fs'));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${name}: ${gl.getProgramInfoLog(p)}`);
    }
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const key = info.name.replace(/\[0\]$/, '');
      uniforms[key] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
    }
    return { gl, prog: p, uniforms, name, unit: 0 };
  }

  function use(p) {
    p.gl.useProgram(p.prog);
    p.unit = 0;
    return p;
  }

  function set(p, name, v) {
    const u = p.uniforms[name];
    if (!u) return;
    const gl = p.gl;
    switch (u.type) {
      case gl.FLOAT: u.size > 1 ? gl.uniform1fv(u.loc, v) : gl.uniform1f(u.loc, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
      case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, v); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
      default: gl.uniform1i(u.loc, v);
    }
  }

  function setAll(p, obj) {
    for (const k in obj) set(p, k, obj[k]);
  }

  function tex(p, name, texture) {
    const u = p.uniforms[name];
    if (!u) return;
    const gl = p.gl;
    gl.activeTexture(gl.TEXTURE0 + p.unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(u.loc, p.unit);
    p.unit++;
  }

  function texture(gl, w, h, ifmt, fmt, type, filter, data) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data || null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t.w = w;
    t.h = h;
    return t;
  }

  function framebuffer(gl, textures) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    textures.forEach((t, i) =>
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: 0x' + status.toString(16));
    f.w = textures[0].w;
    f.h = textures[0].h;
    return f;
  }

  L.GL = { program, use, set, setAll, tex, texture, framebuffer };
})(window.LUMEN = window.LUMEN || {});
