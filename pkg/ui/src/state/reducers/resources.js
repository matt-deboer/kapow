import { types } from '../actions/resources'
import { types as session } from '../actions/session'
import yaml from 'js-yaml'
import queryString from 'query-string'
import { LOCATION_CHANGE } from 'react-router-redux'
import { arraysEqual } from '../../comparators'
import { keyForResource, statusForResource, sameResource } from '../../utils/resource-utils'
import { applyFiltersToResource, splitFilter } from '../../utils/filter-utils'
import { removeReadOnlyFields } from '../../utils/request-utils'

const initialState = {
  // the filter names in string form
  filterNames:[],
  // filters are store as a nested set of maps:
  //  map[key] => map[value] => true
  // TODO: consider leveraging the filter mechanism from kubernetes-ui/filters
  filters: {},
  // the list of possible filters (strings), used for auto-complete
  possibleFilters: [],
  // the currently selected resource
  resource: null,
  // the currently requested resource cannot be found
  resourceNotFound: false,
  // pods that are transitively owned by the currently selected resource
  pods: {},
  // total number of pods seen
  podCount: 0,
  // resources are stored as a nested set of maps:
  //  map[kind] => map[namespace] => map[name] => resource
  resources: {},
  // resources whose `statusSummary` field is in ('error', 'warning', or 'timed out')
  problemResources: {},
  // last time the full set of resources was loaded; we need to
  // reload all resources on some regular cadence to account for 
  // possible missed events
  lastLoaded: 0,
  // all namespaces
  namespaces: [],
  editor: {
    format: 'yaml'
  },
  // isFetching: false,
  countsByKind: {},
  countsByNamespace: {},
  // fetchBackoff: 0,
  // fetchError: null,
  watches: null,
  // kinds in this set are not supported by this cluster
  disabledKinds: {},
  // is a map[node-name]string[]
  podsByNode: {},
  // the maximum resourceVersion value seen across all resource fetches
  // by kind--this allows us to set watches more efficiently; 
  // TODO: we may need to store this on a per-resource basis, 
  // as the fetches for different resource kinds occur independently
  maxResourceVersionByKind: {},
  // a value used internally to handle fast notification of when the
  // resources have changed in a way such that they should be re-rendered
  resourceRevision: 0,
  subjects: [],
}

export default (state = initialState, action) => {
  
  switch (action.type) {
    
    case session.INVALIDATE:
      doCleanup(state)
      return initialState

    case LOCATION_CHANGE:
      return doSetFiltersByLocation(state, action.payload)

    case types.DISABLE_KIND:
      return doDisableKind(state, action.kind)

    case types.REPLACE_ALL:
      return doReceiveResources(state, action.resources)

    case types.FILTER_ALL:
      return doFilterAll(state, state.resources)

    case types.SET_FILTER_NAMES:
      return doSetFilterNames(state, action.filterNames)

    case types.PUT_RESOURCE:
      return doUpdateResource(state, action.resource, action.isNew)

    case types.REMOVE_RESOURCE:
      return doRemoveResource(state, action.resource)

    case types.SELECT_RESOURCE:
      return doSelectResource(state, action.namespace, action.kind, action.name)

    case types.RECEIVE_RESOURCE_CONTENTS:
      return doReceiveResourceContents(state, action.resource, action.contents, action.error)

    case types.SET_WATCHES:
      return {...state, watches: action.watches}

    case types.ADD_FILTER:
      return doAddFilter(state, action.filter)
    
    case types.REMOVE_FILTER:
      return doRemoveFilter(state, action.filter, action.index)
    
    case types.PUT_NAMESPACES:
      return {...state, namespaces: action.namespaces}

    default:
      return state
  }
}

function doCleanup(state) {
  if (state.watches) {
    for (let w in state.watches) {
      state.watches[w].destroy()
    }
  }
}

function doDisableKind(state, kind) {
  if (kind in state.disabledKinds) {
    return state
  }

  let newState = {...state, disabledKinds: {...state.disabledKinds}}
  newState.disabledKinds[kind]=true
  return newState
}

function doSetFiltersByLocation(state, location) {
  
  if (location.pathname === '/workloads') {
    let filterNames = queryString.parse(location.search).filters
    if (!filterNames) {
      filterNames = []
    } else if (filterNames.constructor !== Array) {
      filterNames = [filterNames]
    }
    if (!arraysEqual(filterNames, state.filterNames)) {
      console.log(`updating filter names on location change to ${location}; filterNames: ${filterNames.join(',')}`)
      return doSetFilterNames(state, filterNames)
    } 
  }
  return state
}

function doFilterAll(state, resources) {
  let newState = { ...state, resources: { ...resources }}
  let possible = null
  let subjects = null
  if (!newState.possibleFilters || newState.possibleFilters.length === 0) {
    possible = {}
  }
  if (!newState.subjects || newState.subjects.length === 0) {
    subjects = {}
  }

  visitResources(newState.resources, function(resource) {
    updatePossibleFilters(possible, subjects, resource)
    applyFiltersToResource(newState.filters, resource)
  })

  if (possible !== null) {
    newState.possibleFilters = Object.keys(possible)
  }
  if (subjects !== null) {
    newState.subjects = Object.keys(subjects)
  }

  return newState
}

/**
 * Marks ownership of resources in top-down direction by creating/updating
 * the 'owned' attribute on the owning resource--based on the presence of
 * an 'ownerReferences' value in the provided resource.
 * 
 * @param {*} resources 
 * @param {*} unnresolvedOwnership 
 * @param {*} resource 
 * @param {*} problemResources 
 * @param {*} possibleFilters 
 */
function registerOwned(resources, unnresolvedOwnership, resource, problemResources, possibleFilters) {
  if ('ownerReferences' in resource.metadata) {
    for (let ref of resource.metadata.ownerReferences) {
      let resolved = false
      let ownerKey = keyForResource(ref, resource.metadata.namespace)
      let owner = resources[ownerKey]
      if (!!owner) {
        let owned = owner.owned = owner.owned || {}
        owned[resource.key] = resource

        // problemResources can depend on descendents' status summaries
        owner.statusSummary = statusForResource(owner)
        if (!!owner.statusSummary && 'error warning timed out'.includes(owner.statusSummary)) {
          problemResources[owner.key] = owner
        } else if (owner.key in problemResources) {
          delete problemResources[owner.key]
        }
        possibleFilters[`status:${owner.statusSummary}`]=true

        resolved = true
        registerOwned(resources, unnresolvedOwnership, owner, problemResources, possibleFilters)

      }
      if (!resolved) {
        unnresolvedOwnership[ownerKey] = unnresolvedOwnership[ownerKey] || []
        unnresolvedOwnership[ownerKey].push(resource)
        // console.warn(`owner ref ${keyForResource(ref)} for resource ${resource.key} could not be resolved`)
      }
    }
  }
}

function updatePossibleFilters(possible, subjects, resource) {
  if (!!possible) {
    if (resource.metadata && resource.metadata.namespace) {
      possible[`namespace:${resource.metadata.namespace}`]=true
    }
    possible[`kind:${resource.kind}`]=true
    if (resource.metadata.labels && 'app' in resource.metadata.labels) {
      possible[`app:${resource.metadata.labels.app}`]=true
    }
    possible[`status:${resource.statusSummary}`]=true
    if (resource.kind === 'Pod') {
      possible[`node:${resource.spec.nodeName}`]=true
    }
    if (resource.kind === 'RoleBinding' || resource.kind === 'ClusterRoleBinding') {
      for (let subject of resource.subjects) {
        possible[`subject:${subject.name}`]=true
        if (!!subjects) {
          subjects[`${subject.kind}:${subject.name}`]=true
        }
      }
      possible[`role:${resource.roleRef.name}`]=true
    }
  }
}

function doUpdateResource(state, resource, isNew) {
  resource.key = keyForResource(resource)
  if (!(resource.key in state.resources) && !isNew && resource.kind !== 'Pod') {
    return state
  }
  resource.statusSummary = statusForResource(resource)

  let newState = {...state}
  let possible = {}
  for (let pf of newState.possibleFilters) {
    possible[pf]=true
  }

  registerOwned(newState.resources, {}, resource, newState.problemResources, possible)
  if (!!resource.statusSummary && 'error warning timed out'.includes(resource.statusSummary)) {
    newState.problemResources[resource.key] = resource
  } else if (resource.key in newState.problemResources) {
    delete newState.problemResources[resource.key]
  }
  newState.possibleFilters = Object.keys(possible)

  if (isNew) {
    newState.countsByKind[resource.kind] = newState.countsByKind[resource.kind] || 0 
    newState.countsByKind[resource.kind]++
    newState.countsByNamespace[resource.metadata.namespace] = newState.countsByNamespace[resource.metadata.namespace] || 0 
    newState.countsByNamespace[resource.metadata.namespace]++
  }

  if (isNew && resource.kind === 'Pod') {
    ++newState.podCount
    newState.podsByNode[resource.spec.nodeName] = newState.podsByNode[resource.spec.nodeName] || {}
    newState.podsByNode[resource.spec.nodeName][resource.key] = resource
  } else {
    // TODO: what if pod changes nodes?
  }
  if (resource.metadata.resourceVersion > state.maxResourceVersionByKind[resource.kind]) {
    newState.maxResourceVersionByKind = {...state.maxResourceVersionByKind}
    newState.maxResourceVersionByKind[resource.kind] = resource.metadata.resourceVersion
    if (typeof newState.maxResourceVersionByKind[resource.kind] !== 'number') {
      newState.maxResourceVersionByKind[resource.kind] = 
        parseInt(newState.maxResourceVersionByKind[resource.kind], 10)
    }
  }

  if (isNew || resource.kind !== 'Endpoints') {
    ++newState.resourceRevision
  }

  if (sameResource(newState.resource, resource)) {
    newState = doSelectResource(newState, 
      resource.metadata.namespace, resource.kind, resource.metadata.name)
  }
  
  return doFilterResource(newState, resource)
}

function doFilterResource(newState, resource) {
  newState.resources = {...newState.resources}
  newState.resources[resource.key] = resource
  if (newState.resource && newState.resource.key === resource.key) {
    newState.resource = resource
  }
  applyFiltersToResource(newState.filters, resource)
  return newState
}

function doRemoveResource(state, resource) {
  
  if (resource.key in state.resources) {
    let resources = { ...state.resources }
    delete resources[resource.key]
    let podsByNode = {...state.podsByNode}
    delete podsByNode[resource.spec.nodeName][resource.key]
    let countsByKind = {...state.countsByKind}
    countsByKind[resource.kind] -= 1
    let countsByNamespace = {...state.countsByNamespace}
    countsByNamespace[resource.metadata.namespace] -= 1

    if (countsByNamespace[resource.metadata.namespace] === 0) {
      delete countsByNamespace[resource.metadata.namespace]
    }

    return { ...state,
      countsByKind: countsByKind,
      resources: resources,
      podCount: (state.podCount - 1),
      podsByNode: podsByNode,
    }    
  }
  return state
}

function doSelectResource(state, namespace, kind, name) {

  let pods = {}
  let key = keyForResource({kind: kind, namespace: namespace, name: name})
  let resource = state.resources[key]

  // When a resource is selected, we find all pods that are
  // owned by that resource
  let resourceNotFound = false
  if (!!resource) {
    if (kind === 'Pod') {
      pods[name] = resource
    } else {
      if ('owned' in resource) {
        let owners = [resource]
        while (owners.length > 0) {
          let owner = owners.shift()
          if ('owned' in owner) {
            for (let key in owner.owned) {
              let owned = owner.owned[key]
              if (owned.kind === 'Pod') {
                pods[owned.metadata.name] = owned
              } else if ('owned' in owned) {
                owners.push(owned)
              }
            }
          }
        }
      }
    }
  } else {
    resourceNotFound = true
  }

  return { ...state, 
    resource: resource,
    resourceNotFound: resourceNotFound,
    pods: pods, 
  }
}

function doReceiveResources(state, resources) {
  
  let newState = {...state, 
    possibleFilters: [],
    resources: {...state.resources, ...resources},
    podCount: 0,
    problemResources: {},
    lastLoaded: Date.now(),
    podsByNode: {},
    namespaces: {},
    countsByKind: {},
  }
  
  let possible = {}
  let subjects = {}
  let unnresolvedOwnership = {}

  visitResources(resources, function(resource) {
    resource.statusSummary = statusForResource(resource)
    registerOwned(newState.resources, unnresolvedOwnership, resource, newState.problemResources, possible)
    updateProblemResources(newState, resource)
    updatePossibleFilters(possible, subjects, resource)
    applyFiltersToResource(newState.filters, resource)
    updateVersionByKind(newState, resource)
    updatePodCount(newState, resource)
    updateResourceCounts(newState, resource)
  })

  for (let ownerKey in unnresolvedOwnership) {
    let owned = unnresolvedOwnership[ownerKey]
    for (let resource of owned) {
      console.warn(`owner ref ${ownerKey} for resource ${resource.key} could not be resolved`)
    }
  }

  newState.possibleFilters = Object.keys(possible)
  newState.subjects = Object.keys(subjects)
  ++newState.resourceRevision
  return newState
}

function updateProblemResources(state, resource) {
  if (!!resource.statusSummary && 'error warning timed out'.includes(resource.statusSummary)) {
    state.problemResources[resource.key] = resource
  }
}

function updateVersionByKind(state, resource) {
  
  let currentMax = state.maxResourceVersionByKind[resource.kind] || 0
  if (typeof currentMax !== 'number') {
    currentMax = parseInt(currentMax, 10)
  }
  let resourceVersion = resource.metadata.resourceVersion
  if (typeof currentMax !== 'number') {
    resourceVersion = parseInt(resourceVersion, 10)
  }

  state.maxResourceVersionByKind[resource.kind] = Math.max(currentMax, resourceVersion)
}

function updatePodCount(state, resource) {
  if (resource.kind === 'Pod') {
    ++state.podCount
    state.podsByNode[resource.spec.nodeName] = state.podsByNode[resource.spec.nodeName] || {}
    state.podsByNode[resource.spec.nodeName][resource.key] = resource
  }
}

function updateResourceCounts(state, resource) {
  state.countsByKind[resource.kind] = state.countsByKind[resource.kind] || 0
  state.countsByKind[resource.kind]++
  state.countsByNamespace[resource.metadata.namespace] = state.countsByNamespace[resource.metadata.namespace] || 0 
  state.countsByNamespace[resource.metadata.namespace]++
}

/**
 * Iterates the provided set of resources, applying
 * the included set of functions to each
 * 
 * @param {*} resources 
 * @param {*} visitors one or more functions of the form (resources)
 */
function visitResources(resources, ...visitors) {
  for (let key in resources) {
    let resource = resources[key]
    for (let visitor of visitors) {
      visitor(resource)
    }
  }
}

function doReceiveResourceContents(state, resource, contents, error) {
  if (contents && state.editor.format) {
    filterContents(contents)
    if (state.editor.format === 'yaml') {
      contents = formatYaml(contents)
    } else {
      contents = JSON.stringify(contents)
    }
  }
  
  return { ...state, editor: {
        resource: resource, 
        contents: contents, 
        error: error, 
        format: 'yaml',
      }
    }
}

/**
 * Format the editor contents for consistency with `kubectl edit...`
 * 
 * @param {*} contents 
 */
function filterContents(contents) {
  // These are all read-only field values; we just hide them for now,
  // although it would be nice to display them in some sort of readonly
  // fashion for reference
  removeReadOnlyFields(contents)
}

function formatYaml(contents) {
  let value = yaml.safeDump(contents, {
      '!!null': 'lowercase',
      'noRefs': true,
      'sortKeys': true,
    })
  return value
}

/**
 * Adds the specified filter (if it is not already present),
 * and returns a new state as appropriate
 * 
 * @param {Object} state the current state
 * @param {String} filterName the filterName to add
 */
function doAddFilter(state, filterName) {
  let filters = { ...state.filters }
  let filterNames = state.filterNames.slice(0)
  
  if (addFilter(filters, filterNames, filterName)) {
    return doFilterAll({ ...state,
      filterNames: filterNames,
      filters: filters
    }, state.resources)
  } else {
    return state
  }
}

/**
 * Return a new state where filters are defined (and applied)
 * based on the provided array of filterNames
 * 
 * @param {*} state the current state
 * @param {*} filterNames the filter names to apply
 */
function doSetFilterNames(state, filterNames) {
  let newFilters = {}
  let newFilterNames = []
  addFilter(newFilters, newFilterNames, ...filterNames)
  
  return doFilterAll({ ...state,
    filterNames: newFilterNames,
    filters: newFilters,
  }, state.resources)
}

/**
 * Adds one or more filters, applying changes to the provided 'filters'
 * object and 'filterNames' array as appropriate.
 * Returns `true` if the filter(s) were added (were not already present)
 * 
 * @param {Object} filters the existing hash of filter objects to modify
 * @param {Array} filterNames the existing array of filterNames to modify
 * @param {Array} newFilterNames one or more new filter names to add
 */
function addFilter(filters, filterNames, ...newFilterNames) {
  let modified = false
  for (let filterName of newFilterNames) {
    let [filterKey, filterValue] = splitFilter(filterName)
    if (!(filterKey in filters) || !(filterValue in filters[filterKey])) {
      let filter = filters[filterKey] = (filters[filterKey] || {})
      filter[filterValue]=true
      filterNames.push(filterName)
      modified = true
    }
  }
  return modified
}

/**
 * Removes a filter, applying the change to the provided filters
 * object and the filterNames array as appropriate
 * 
 * @param {Object} filters the filters hash
 * @param {Array} filterNames the array of serialized filter names
 * @param {String} filterName the filter name to be added
 * @param {Number} index the index of the filterName being removed
 */
function removeFilter(filters, filterNames, filterName, index) {
  let [filterKey, filterValue] = splitFilter(filterName)
  var filter = filters[filterKey]
  if (filter) {
    delete filter[filterValue]
    if (Object.keys(filter).length === 0) {
      delete filters[filterKey]
    }
  }
  if (index !== undefined) {
    filterNames.splice(index, 1)
  } else {
    // have to find the correct index
    for (let i=0; i < filterNames.length; ++i) {
      if (filterNames[i] === filterName) {
        filterNames.splice(i, 1)
        break
      }
    }
  }
}

/**
 * Removes the specified filter, and re-applies all filters to
 * the current set of resources, returning a new state
 * 
 * @param {*} state the existing state
 * @param {*} filterName the filter to remove
 * @param {*} index the index of the filter to remove
 */
function doRemoveFilter(state, filterName, index) {

  var filters = { ...state.filters }
  var filterNames = state.filterNames.slice(0)

  removeFilter(filters, filterNames, filterName, index)

  // need to re-apply filters after removing one
  return doFilterAll({ ...state,
    filterNames: filterNames,
    filters: filters
  }, state.resources)
}
