import { receiveEvents } from '../state/actions/events'

export default class EventsWatcher {

  constructor(props) {

    this.props = props

    if (!!props.dispatch && !!props.getState) {
      this.dispatch = props.dispatch
      let resourceVersion = props.resourceVersion || 0

      let loc = window.location
      let scheme = (loc.protocol === 'https:' ? 'wss' : 'ws')
      
      let url = `${scheme}://${loc.host}/proxy`
      url += `/api/v1/events`
      url += `?watch=true&resourceVersion=${resourceVersion}`
      
      this.socket = new WebSocket(url)
      this.socket.onerror = function (e) {
        console.error(`EventsWatcher`, e)
      }
      this.socket.onmessage = this.onEvent.bind(this)
      console.log(`EventsWatcher created`)
    }
  }

  closed = () => {
    return this.socket.readyState === 3 || this.socket.readyState === 2
  }

  onEvent = (event) => {
    let data = JSON.parse(event.data)
    if (!!data) {
      let resources = this.props.getState().resources.resources
      this.dispatch(receiveEvents(resources, data))
    }
  }

  destroy = () => {
    this.socket && this.socket.close()
  }  
}
