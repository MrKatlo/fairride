module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Reanimated 4 delegates its worklet transform to react-native-worklets.
    // This plugin must stay LAST in the list (it is the only one here).
    plugins: ['react-native-worklets/plugin'],
  };
};
