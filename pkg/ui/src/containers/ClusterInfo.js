import React from 'react'
import { connect } from 'react-redux'
import { routerActions } from 'react-router-redux'
import { editResource, removeResource, requestResource, applyResourceChanges } from '../state/actions/resources'
import { invalidateSession } from '../state/actions/session'
import { tryGoBack } from '../state/actions/location'
import { withRouter } from 'react-router-dom'
import ResourceInfoPage from '../components/ResourceInfoPage'
import LoadingSpinner from '../components/LoadingSpinner'
import LogFollower from '../utils/LogFollower'
import queryString from 'query-string'
import ResourceNotFoundPage from '../components/ResourceNotFoundPage'
import { sameResourceVersion, sameResource, resourceMatchesParams } from '../utils/resource-utils'
import Loadable from 'react-loadable'
import LoadingComponentStub from '../components/LoadingComponentStub'

const AsyncEditorPage = Loadable({
  loader: () => import('../components/EditorPage'),
  loading: LoadingComponentStub
})


const mapStateToProps = function(store) {
  return { 
    resource: store.resources.resource,
    fetching: store.requests.fetching,
    user: store.session.user,
    editor: store.resources.editor,
    logPodContainers: store.logs.podContainers,
    events: store.events.selectedEvents,
  }
}

const mapDispatchToProps = function(dispatch, ownProps) {
  return {
    editResource: function(namespace, kind, name) {
      dispatch(editResource(namespace, kind, name))
    },
    cancelEditor: function() {
      dispatch(tryGoBack())
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
    removeResource: function(resource) {
      dispatch(removeResource(resource))
      dispatch(tryGoBack())
    },
    requestResource: function(namespace, kind, name) {
      dispatch(requestResource(namespace, kind, name))
    },
    invalidateSession: function() {
      dispatch(invalidateSession())
    },
    selectView: function(tab) {
      if (tab === 'edit') {
        let { params } = ownProps.match
        dispatch(editResource(params.namespace, params.kind, params.name))
      }
      
      let { location } = ownProps
      let newSearch = `?view=${tab}`
      dispatch(routerActions.push({
        pathname: location.pathname,
        search: newSearch,
        hash: location.hash,
      }))
    },
    dispatch: dispatch,
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
    this.logFollowers = {}
    this.events = []
    this.logs = new LogFollower.Buffer()

    this.ensureResource(props)
  }

  ensureResource = (props) => {
    let editing = (props.location.search === '?view=edit')
    let { params } = props.match
    if (editing && !props.editor.contents) {
      props.editResource(params.namespace, params.kind, params.name)
    } else if (!!props.user && !resourceMatchesParams(props.resource, params)) {
      props.requestResource(params.namespace, params.kind, params.name)
    }
  }

  componentWillReceiveProps = (props) => {
    
    if (!sameResourceVersion(this.state.resource,props.resource)
      || (props.editor.contents !== this.props.editor.contents)
      || (props.resource && this.state.resource && props.resource.metadata.resourceVersion )
    ) {
      this.setState({
        resource: props.resource,
        editor: props.editor,
      })
    }
    this.ensureResource(props)
  }

  shouldComponentUpdate = (nextProps, nextState) => {
    return !sameResource(this.state.resource, nextProps.resource)
        || this.props.user !== nextProps.user
        || this.state.editor.contents !== nextProps.editor.contents
        || this.props.location !== nextProps.location
        || this.props.events !== nextProps.events
  }

  componentWillUnmount = () => {
    for (let key in this.logFollowers) {
      let logFollower = this.logFollowers[key]
      logFollower && logFollower.destroy()
    }
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

  onLogsActivated = () => {
    // this.watchLogs()
  }

  render() {

    let { logs, events, props } = this
    
    let fetching = Object.keys(props.fetching).length > 0
    let resourceInfoPage = null
    let resourceNotFound = null
    let query = queryString.parse(this.props.location.search)
    let activeTab = query.view || 'config'

    if (!!this.state.resource) {
      if (this.state.resource.notFound && !fetching) {
        resourceNotFound = <ResourceNotFoundPage resourceGroup={'workloads'} {...props.match.params}/>
      } else {
        resourceInfoPage = 
          
          <ResourceInfoPage
            removeResource={props.removeResource}
            editResource={props.editResource}
            viewKind={props.viewKind}
            viewFilters={props.viewFilters}
            selectView={props.selectView}
            resourceGroup={'cluster'}
            resource={this.state.resource}
            logs={logs}
            events={events}
            onLogsActivated={this.onLogsActivated.bind(this)}
            activeTab={activeTab}
            />
      }
    }

    return (<div>
      
      <AsyncEditorPage 
        open={!!this.state.resource && !!this.state.editor.contents && props.location.search === '?view=edit'}
        onEditorApply={props.onEditorApply}
        onEditorCancel={this.onEditorCancel}
        resource={this.state.resource}
        resourceGroup={'cluster'}
        contents={this.state.editor.contents}
        />

        
      {resourceInfoPage}
      {resourceNotFound}

      <LoadingSpinner loading={!this.state.resource || (this.state.resource.notFound && fetching)} />
    </div>)
  }
}))