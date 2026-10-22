module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // @atproto/jwk ships static class blocks that the default preset
    // doesn't transform for the web target
    plugins: ['@babel/plugin-transform-class-static-block'],
  };
};
