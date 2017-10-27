export var types = {}
for (let type of [
  'SELECT_NAMESPACES',
  'PUT_SETTINGS',
]) {
  types[type] = `usersettings.${type}`
}

export function selectNamespaces(namespaces) {
  return {
    type: types.SELECT_NAMESPACES,
    namespaces: namespaces,
  }
}

export function updateSettings(namespaces, kinds, save) {
  return {
    type: types.PUT_SETTINGS,
    namespaces: namespaces,
    kinds: kinds,
    save: save,
  }
}