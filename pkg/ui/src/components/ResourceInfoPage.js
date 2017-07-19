import React from 'react'
import {blueA400, grey600, grey700, blueA100} from 'material-ui/styles/colors'
import { connect } from 'react-redux'
import sizeMe from 'react-sizeme'
import { routerActions } from 'react-router-redux'
import { editResource, removeResource } from '../state/actions/workloads'

import {Card, CardHeader} from 'material-ui/Card'
import ConfigurationPane from './configuration-pane/ConfigurationPane'
import PodTemplatePane from './configuration-pane/PodTemplatePane'
import LogViewer from './LogViewer'
import EventViewer from './EventViewer'
import TerminalViewer from './TerminalViewer'

import IconConfiguration from 'material-ui/svg-icons/action/list'
import IconPodTemplate from 'material-ui/svg-icons/action/flip-to-back'
import IconLogs from 'material-ui/svg-icons/action/receipt'
import IconTerminal from 'material-ui/svg-icons/hardware/computer'
import IconEvents from 'material-ui/svg-icons/action/event'
import IconExpand from 'material-ui/svg-icons/navigation/more-vert'
import IconEdit from 'material-ui/svg-icons/editor/mode-edit'
import IconDelete from 'material-ui/svg-icons/action/delete'

import FilterChip from './FilterChip'

import { withRouter } from 'react-router-dom'

import {Tabs, Tab} from 'material-ui/Tabs'

import LoadingSpinner from './LoadingSpinner'

import RaisedButton from 'material-ui/RaisedButton'
import Popover from 'material-ui/Popover'
import Menu from 'material-ui/Menu'
import MenuItem from 'material-ui/MenuItem'
import KubeKinds from '../kube-kinds'
import KindAbbreviation from './KindAbbreviation'
import queryString from 'query-string'

import { resourceStatus as resourceStatusIcons } from './icons'

import './ResourceInfoPage.css'

const mapStateToProps = function(store) {
  return {
    filterNames: store.workloads.filterNames,
    pods: store.workloads.pods,
  }
}

const mapDispatchToProps = function(dispatch, ownProps) {
  return {
    editResource: function(namespace, kind, name) {
      dispatch(editResource(namespace, kind, name))
      ownProps.selectView('edit')
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

const styles = {
  tabs: {
    backgroundColor: grey600,
  },
  tabsInkBar: {
    backgroundColor: blueA400,
    height: 3,
    marginTop: -4,
    borderTop: `1px ${blueA100} solid`,
  },
  cards: {
    margin: 10,
    boxShadow: 'none',
  },
  cardHeader: {
    borderBottom: '1px solid rgba(0,0,0,0.1)',
  },
  cardHeaderTitle: {
    color: 'rgba(0,0,0,0.4)',
    fontWeight: 600,
    // fontStyle: 'italic',
    fontSize: '18px',
  }
}


export default withRouter(connect(mapStateToProps, mapDispatchToProps) (
sizeMe({ monitorHeight: true, monitorWidth: true }) (
class ResourceInfoPage extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      actionsOpen: false,
      editing: false,
    }
    this.kubeKind = !!props.resource && KubeKinds[props.resourceGroup][props.resource.kind]
  }

  handleActionsTouchTap = (event) => {
    // This prevents ghost click.
    event.preventDefault();
    this.setState({
      actionsOpen: true,
      actionsAnchor: event.currentTarget,
    })
  }

  handleActionsRequestClose = () => {
    this.setState({
      actionsOpen: false,
    })
  }

  handleFilterLabelTouchTap = (filters) => {
    this.props.viewFilters(filters)
  }

  componentDidUpdate = () => {
    this.kubeKind = !!this.props.resource && KubeKinds[this.props.resourceGroup][this.props.resource.kind]
  }

  render() {

    let { resourceGroup, resource, logs, activeTab, enableLogsTab, enableTerminalTab } = this.props

    let tabs = [
      {
        name: 'config',
        component: ConfigurationPane,
        icon: <IconConfiguration/>,
        props: {resource: resource, resourceGroup: resourceGroup},
      }
    ]
    
    if (resource.spec && resource.spec.template) {
      tabs.push({
        name: 'pod template',
        component: PodTemplatePane,
        icon: <IconPodTemplate/>,
        props: {resource: resource},
      })
    }
    
    tabs.push({
      name: 'events',
      component: EventViewer,
      icon: <IconEvents/>,
    })

    if (enableLogsTab) {
      tabs.push({
        name: 'logs',
        component: LogViewer,
        icon: <IconLogs/>,
        props: {logs: logs},
      })
    }
    if (enableTerminalTab) {
      tabs.push({
        name: 'terminal',
        component: TerminalViewer,
        icon: <IconTerminal/>,
        props: {logs: logs},
      })
    }

    activeTab = (activeTab || tabs[0].name)

    return (
      <div>
        <LoadingSpinner hidden={!this.props.resource}/>

        <Card className="resource-info" style={{margin: 5}} >
          <CardHeader
            title={resource.metadata.name}
            subtitle={
              <div style={{padding: 20}}>
                <div>
                {resource.metadata.labels && Object.entries(resource.metadata.labels).map(([key, value]) =>
                  <FilterChip 
                    onTouchTap={this.handleFilterLabelTouchTap.bind(this,[`namespace:${resource.metadata.namespace}`, `${key}:${value}`])} 
                    key={key} 
                    prefix={key} 
                    suffix={value} />)
                }
                </div>
                <div>
                  <FilterChip 
                    onTouchTap={this.handleFilterLabelTouchTap.bind(this,[`namespace:${resource.metadata.namespace}`])} 
                    prefixStyle={{color: grey700}} 
                    prefix={'namespace'} suffix={resource.metadata.namespace} />
                  <FilterChip 
                    onTouchTap={this.handleFilterLabelTouchTap.bind(this,[`namespace:${resource.metadata.namespace}`,`kind:${resource.kind}`])} 
                    prefixStyle={{color: grey700}} 
                    prefix={'kind'} suffix={resource.kind} />
                </div>
              </div>
            }
            avatar={<KindAbbreviation text={this.kubeKind.abbrev} color={this.kubeKind.color}/>}
            titleStyle={{fontSize: '24px', fontWeight: 600, paddingLeft: 10}}
            style={{minHeight: '125px'}}
          >
            
            <RaisedButton
              label="Actions"
              labelPosition="before"
              onTouchTap={this.handleActionsTouchTap}
              icon={<IconExpand/>}
              style={{position: 'absolute', right: 20, top: 20}}
              primary={true}
            />
            <Popover
              open={this.state.actionsOpen}
              anchorEl={this.state.actionsAnchor}
              onRequestClose={this.handleActionsRequestClose}
              anchorOrigin={{horizontal: 'right', vertical: 'bottom'}}
              targetOrigin={{horizontal: 'right', vertical: 'top'}}
            >
              <Menu desktop={true}>
                <MenuItem primaryText="Edit" 
                  onTouchTap={() => {
                    this.props.selectView('edit')
                    this.setState({actionsOpen: false})
                  }}
                  leftIcon={<IconEdit/>}
                  />
                <MenuItem primaryText="Delete" 
                  leftIcon={<IconDelete/>}
                  onTouchTap={() => {
                    this.props.removeResource(this.props.resource, this.props.filterNames)
                  }}
                  />
              </Menu>
            </Popover>
            <div style={{top: 85, left: 32, position: 'absolute'}}>{resourceStatusIcons[resource.statusSummary]}</div>

          </CardHeader>
        
          <Tabs 
            tabItemContainerStyle={styles.tabs}
            contentContainerStyle={{overflow: 'hidden'}}
            inkBarStyle={styles.tabsInkBar}
            className={`resource-tabs ${activeTab.replace(" ","-")}`}
            value={activeTab}
            ref={ (ref) => {
                if (!!ref) {
                  // get absolute bottom of the tab button bar so our tab contents can fill available space
                  let tabButtons = document.getElementsByClassName('resource-tabs')[0].children[0]
                  this.contentTop = tabButtons.getBoundingClientRect().bottom
                }
              }
            }
            >
            {tabs.map(tab => {              
                let Component = tab.component
                return <Tab key={tab.name} icon={tab.icon} label={tab.name} value={tab.name} onActive={this.props.selectView.bind(this, tab.name)}>
                  <Component {...tab.props} contentTop={this.contentTop}/>
                </Tab>
              }
            )}
          </Tabs>
        </Card>
      </div>
    )
  }
})))
