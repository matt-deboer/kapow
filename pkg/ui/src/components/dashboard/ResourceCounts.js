import React from 'react'
import PropTypes from 'prop-types'
import { List, ListItem } from 'material-ui/List'
import Subheader from 'material-ui/Subheader'
import Divider from 'material-ui/Divider'
import Paper from 'material-ui/Paper'
import { white } from 'material-ui/styles/colors'
import { Link } from 'react-router-dom'
import { connect } from 'react-redux'
import HelpText from '../../i18n/help-text'

const mapStateToProps = function(store) {
  return {
    kinds: store.apimodels.kinds,
    selectedNamespaces: store.usersettings.selectedNamespaces,
    resources: store.resources.resources,
    linkGenerator: store.session.linkGenerator,
  }
}

const mapDispatchToProps = function(dispatch, ownProps) {
  return {
  }
}

export default connect(mapStateToProps, mapDispatchToProps) (
class ResourceCounts extends React.PureComponent {

  static propTypes = {
    selectedNamespaces: PropTypes.object,
    resources: PropTypes.object,
  }

  render() {

    let { props } = this
    let { resources, selectedNamespaces, linkGenerator } = props

    const styles = {
      wrapper: {
        marginTop: 0,
        backgroundColor: 'rgb(80,80,80)',
        border: '1px solid rgba(0,0,0,0.5)',
      },
      subheader: {
        fontSize: 18,
        color: white,
        backgroundColor: 'rgba(41, 121, 255, 0.8)',
        borderBottom: '1px solid rgba(0,0,0,0.5)',
        lineHeight: '30px',
      },
      secondary: {
        overflow: 'visible',
        paddingBottom: 20,
        height: 'inherit',
        whitespace: 'normal'
      },
      message: {
        overflow: 'visible',
        whiteSpace: 'normal',
        paddingBottom: 10,
      },
      type: {
        fontWeight: 600,
      },
      item: {
        wordWrap: 'break-word',
        padding: 8,
        color: 'rgb(240,240,240)',
        fontSize: 14,
      },
      count: {
        float: 'right',
        paddingRight: 15,
      },
      divider: {
        backgroundColor: 'rgba(224, 224, 224, 0.2)',
      },
      link: {
        color: 'rgb(240, 240, 240)',
      }
    }

    let countsByKind = {}
    let namespacesFiltered = (Object.keys(selectedNamespaces).length > 0)
    for (let key in resources) {
      let resource = resources[key]
      if (!namespacesFiltered || resource.metadata.namespace in selectedNamespaces) {
        countsByKind[resource.kind] = (countsByKind[resource.kind] || 0) + 1
      }
    }

    let items = []
    for (let kind in countsByKind) {
      if (kind === 'Endpoints' || kind === 'ReplicaSet') {
        continue
      }
      let name = kind
      if (!(name.endsWith('s'))) {
        name += 's'
      } else if (name.endsWith('ss')) {
        name += 'es'
      }
      let link = linkGenerator.linkForKind(kind, selectedNamespaces)

      items.push(
        <div key={kind}>
          <ListItem
            disabled={true}
            leftIcon={null}
            primaryText={<div>
              <Link to={link} style={styles.link}>{name}</Link>
              <span style={styles.count}>{countsByKind[kind]}</span>
            </div>
            }
            style={styles.item}
          />
          <Divider inset={false} style={styles.divider}/>
        </div>
      )
    }

    return (
      <Paper style={styles.wrapper}>
        <HelpText style={{position: 'absolute', top: 7, right: 25}} locale={'en'} textId={'ResourceCounts'}/>
        <Subheader style={styles.subheader}>Resource Counts</Subheader>
        <List className={'list-contents'}>
          {items}
        </List>
      </Paper>
    )
  }
})
