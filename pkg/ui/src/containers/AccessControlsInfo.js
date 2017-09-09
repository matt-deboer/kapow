import React from 'react'
import { connect } from 'react-redux'
import { routerActions } from 'react-router-redux'
import { applyResourceChanges, requestResource, editResource, removeResource } from '../state/actions/access'
import { invalidateSession } from '../state/actions/session'
import { withRouter } from 'react-router-dom'
import ResourceInfoPage from '../components/ResourceInfoPage'
import LoadingSpinner from '../components/LoadingSpinner'
import { sameResource } from '../utils/resource-utils'
import queryString from 'query-string'
import Loadable from 'react-loadable'
import LoadingComponentStub from '../components/LoadingComponentStub'
import { linkForResourceKind } from '../routes'

const AsyncEditorPage = Loadable({
  loader: () => import('../components/EditorPage'),
  loading: LoadingComponentStub
})


const mapStateToProps = function(store) {
  return { 
    resource: store.access.resource,
    resources: store.access.resources,
    isFetching: store.access.isFetching,
    user: store.session.user,
    editor: store.access.editor,
    events: store.events.selectedEvents,
  }
}

const mapDispatchToProps = function(dispatch, ownProps) {
  return {
    cancelEditor: function() {
      dispatch(routerActions.goBack())
    },
    onEditorApply: function(contents) {
      let { namespace, kind, name } = ownProps.match.params
      dispatch(applyResourceChanges(namespace, kind, name, contents))
      let { location } = ownProps
      let newSearch = '?view=config'
      dispatch(routerActions.push({
        pathname: location.pathname,
        search: newSearch,
        hash: location.hash,
      }))
    },
    requestResource: function(namespace, kind, name) {
      dispatch(requestResource(namespace, kind, name))
    },
    invalidateSession: function() {
      dispatch(invalidateSession())
    },
    editResource: function(namespace, kind, name) {
      dispatch(editResource(namespace, kind, name))
      // ownProps.selectView('edit')
      let { params } = ownProps.match
      dispatch(editResource(params.namespace, params.kind, params.name))
    },
    removeResource: function(resource, filterNames) {
      dispatch(removeResource(resource))
      
      let search = queryString.stringify({filters: filterNames})
      if (!!search) {
        search = '?'+search
      }
      dispatch(routerActions.push({
        pathname: `/${ownProps.resourceGroup}`,
        search: search,
      }))
    },
    viewKind: function(kind, namespace) {
      let ns = {}
      if (!!namespace) {
        ns[namespace] = true
      }
      dispatch(routerActions.push(linkForResourceKind(kind, ns)))
    },
    viewFilters: function(filters) {
      let search = `?${queryString.stringify({filters: filters})}`
      dispatch(routerActions.push({
        pathname: `/${ownProps.resourceGroup}`,
        search: search,
      }))
    },
    selectView: function(tab) {
      if (tab === 'edit') {
        let { params } = ownProps.match
        dispatch(editResource(params.namespace, params.kind, params.name))
      }
      
      let { location } = ownProps
      let newSearch = `?view=${tab}`
      console.log(`selectView: pushed new location...`)
      dispatch(routerActions.push({
        pathname: location.pathname,
        search: newSearch,
        hash: location.hash,
      }))
    },
  }
}

export default withRouter(connect(mapStateToProps, mapDispatchToProps) (
class ClusterInfo extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      resource: props.resource,
      editor: props.editor,
      logPodContainers: props.logPodContainers,
    }
    this.events = []
    this.ensureResource(props)
  }

  ensureResource = (props) => {
    let { namespace, kind, name } = props.match.params
    if (!!props.user && !props.isFetching && 
      (!props.resource || (props.location.search === '?view=edit' && !props.editor.contents)
        || !sameResource(props.resource, {kind: kind, metadata: {namespace: namespace, name: name}})
      ) &&
      (!props.resourceNotFound)
      ) {
    
      let { params } = props.match
      if (props.location.search === '?view=edit') {
        props.editResource(params.namespace, params.kind,params.name)
      } else {
        props.requestResource(params.namespace, params.kind,params.name)
      }
    }
  }

  componentWillReceiveProps = (props) => {
    
    if (!sameResource(this.state.resource,props.resource)
      || (props.editor.contents !== this.props.editor.contents)
      || (props.resource && this.state.resource )
    ) {
      this.setState({
        resource: props.resource,
        editor: props.editor,
      })
    }
  }

  shouldComponentUpdate = (nextProps, nextState) => {
    let shouldUpdate = !sameResource(this.state.resource, nextProps.resource)
        || this.props.isFetching !== nextProps.isFetching
        || this.props.user !== nextProps.user
        || this.state.editor.contents !== nextProps.editor.contents
        || this.props.location !== nextProps.location
        || this.props.events !== nextProps.events
    
    return shouldUpdate
  }

  // componentDidMount = () => {
  //   this.ensureResource(this.props)
  // }

  componentDidUpdate = () => {
    this.ensureResource(this.props)
  }

  componentWillUnmount = () => {
    this.eventFollower && this.eventFollower.destroy()
  }

  onEditorOpen = () => {
    this.props.editResource(
      this.state.resource.metadata.namespace,
      this.state.resource.kind,
      this.state.resource.metadata.name
      )
  }

  onEditorCancel = () => {
    this.props.cancelEditor()
  }

  render() {

    let { resource } = this.state
    let { events, props } = this

    return (<div>
      
      <AsyncEditorPage 
        open={!!this.state.resource && !!this.state.editor.contents && this.props.location.search === '?view=edit'}
        onEditorApply={this.props.onEditorApply}
        onEditorCancel={this.onEditorCancel}
        resource={this.state.resource}
        contents={this.state.editor.contents}
        title={!!resource &&
          <div>
          <span style={{ paddingRight: 10, color: 'rgb(240,240,240)'}}>Editing:</span>
          <span style={{fontWeight: 600, color: 'rgb(240,240,240)'}}>{`${resource.metadata.namespace} / ${resource.kind} / ${resource.metadata.name}`}</span>
          </div>
        }
        />

      {!!this.state.resource &&
        <ResourceInfoPage
          resourceGroup={'access'}
          editResource={props.editResource}
          removeResource={props.removeResource}
          viewKind={props.viewKind}
          viewFilters={props.viewFilters}
          selectView={props.selectView}
          resource={this.state.resource}
          resources={this.props.resources}
          events={events}
          activeTab={(this.props.location.search || 'config').replace('?view=','')}
          />
      }
      
      <LoadingSpinner loading={this.props.isFetching} />
    </div>)
  }
}))