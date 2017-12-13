package proxy

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/matt-deboer/kuill/pkg/auth"
	log "github.com/sirupsen/logrus"

	"bytes"

	"github.com/gorilla/websocket"
)

// KubeKindAggregatingWatchProxy is an HTTP Handler that takes an incoming WebSocket
// connection and proxies it to another server.
type KubeKindAggregatingWatchProxy struct {
	// Director, if non-nil, is a function that may copy additional request
	// headers from the incoming WebSocket connection into the output headers
	// which will be forwarded to another server.
	Director func(incoming *http.Request, out http.Header)

	// Backend returns the backend URL which the proxy uses to reverse proxy
	// the incoming WebSocket connection. Request is the initial incoming and
	// unmodified request.
	Backend func(kindPath string, resourceVersion int) *url.URL

	// Upgrader specifies the parameters for upgrading a incoming HTTP
	// connection to a WebSocket connection. If nil, DefaultUpgrader is used.
	Upgrader *websocket.Upgrader

	//  Dialer contains options for connecting to the backend WebSocket server.
	//  If nil, DefaultDialer is used.
	Dialer *websocket.Dialer

	traceRequests    bool
	kindLister       *KindsProxy
	accessAggregator *AccessAggregator
}

// NewKubeKindAggregatingWatchProxy returns a new Websocket reverse proxy that rewrites the
// URL's to the scheme, host and base path provider in target.
func NewKubeKindAggregatingWatchProxy(target *url.URL, traceRequests bool, kindLister *KindsProxy, accessAggregator *AccessAggregator) *KubeKindAggregatingWatchProxy {
	backend := func(watchPath string, resourceVersion int) *url.URL {
		// Shallow copy
		u := *target
		u.Fragment = ""
		u.Path = watchPath
		u.RawQuery = fmt.Sprintf("watch=true&resourceVersion=%d", resourceVersion)
		return &u
	}

	return &KubeKindAggregatingWatchProxy{Backend: backend, kindLister: kindLister, accessAggregator: accessAggregator}
}

// AggregateWatches implements the http.Handler that proxies multiple WebSocket connections.
func (w *KubeKindAggregatingWatchProxy) AggregateWatches(rw http.ResponseWriter, req *http.Request, authContext auth.Context) {

	if w.Backend == nil {
		log.Error("KubeKindAggregatingWatchProxy: backend function is not defined")
		http.Error(rw, "Internal server error (code: 1)", http.StatusInternalServerError)
		return
	}

	watchable, watchCount, err := w.accessAggregator.GetWatchableResources(authContext)
	if err != nil {
		log.Errorf("KubeKindAggregatingWatchProxy: error recovering watchable resources; %v", err)
		http.Error(rw, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	dialer := w.Dialer
	if w.Dialer == nil {
		dialer = DefaultDialer
	}

	// Pass headers from the incoming request to the dialer to forward them to
	// the final destinations.
	requestHeader := http.Header{}
	if origin := req.Header.Get("Origin"); origin != "" {
		requestHeader.Add("Origin", origin)
	}
	for _, prot := range req.Header[http.CanonicalHeaderKey("Sec-WebSocket-Protocol")] {
		requestHeader.Add("Sec-WebSocket-Protocol", prot)
	}
	for _, cookie := range req.Header[http.CanonicalHeaderKey("Cookie")] {
		requestHeader.Add("Cookie", cookie)
	}

	// Pass X-Forwarded-For headers too, code below is a part of
	// httputil.ReverseProxy. See http://en.wikipedia.org/wiki/X-Forwarded-For
	// for more information
	// TODO: use RFC7239 http://tools.ietf.org/html/rfc7239
	if clientIP, _, err := net.SplitHostPort(req.RemoteAddr); err == nil {
		// If we aren't the first proxy retain prior
		// X-Forwarded-For information as a comma+space
		// separated list and fold multiple headers into one.
		if prior, ok := req.Header["X-Forwarded-For"]; ok {
			clientIP = strings.Join(prior, ", ") + ", " + clientIP
		}
		requestHeader.Set("X-Forwarded-For", clientIP)
	}

	// Set the originating protocol of the incoming HTTP request. The SSL might
	// be terminated on our site and because we doing proxy adding this would
	// be helpful for applications on the backend.
	requestHeader.Set("X-Forwarded-Proto", "http")
	if req.TLS != nil {
		requestHeader.Set("X-Forwarded-Proto", "https")
	}

	// Enable the director to copy any additional headers it desires for
	// forwarding to the remote server.
	if w.Director != nil {
		w.Director(req, requestHeader)
	}

	backendErrors := make(chan error, watchCount)
	var clientConn *websocket.Conn
	outbound := make(chan []byte, 32)
	resourceVersion, _ := strconv.Atoi(req.URL.Query().Get("resourceVersion"))

	for _, watchableKind := range watchable {
		// Connect to the backend URL, also pass the headers we get from the requst
		// together with the Forwarded headers we prepared above.
		for _, ns := range watchableKind.Namespaces {
			kindPath := watchableKind.GetWatchPath(ns)
			if log.GetLevel() >= log.DebugLevel {
				log.Debugf("Got kindPath %s for ns: %s, kind: %s", kindPath, ns, watchableKind.Kind)
			}
			backendURL := w.Backend(kindPath, resourceVersion)
			if backendURL == nil {
				log.Error("KubeKindAggregatingWatchProxy: backend URL is nil")
				// TODO: should we just log this and move on to the next?
				http.Error(rw, "Internal server error (code: 2)", http.StatusInternalServerError)
				return
			} else if log.GetLevel() >= log.DebugLevel {
				log.Debugf("Got backend url of %v for request url of %v",
					backendURL, req.URL)
			}

			if w.traceRequests {
				log.Infof("KubeKindAggregatingWatchProxy: adding ws backend to multiwatch: %v",
					backendURL)
			}

			connBackend, resp, err := dialer.Dial(backendURL.String(), requestHeader)
			if err != nil {
				status := "<none>"
				body := ""
				if resp != nil {
					status = resp.Status
					if resp.Body != nil {
						buff := &bytes.Buffer{}
						buff.ReadFrom(resp.Body)
						body = buff.String()
					}
				}
				backendErrors <- fmt.Errorf("KubeKindAggregatingWatchProxy: couldn't dial to remote backend url %s: %s %s %s", backendURL, err, status, body)
				continue
			}
			defer connBackend.Close()

			if log.GetLevel() >= log.DebugLevel {
				log.Debugf("Starting socket reader for %v => %v...", req.URL, backendURL)
			}
			go w.readMessages(backendURL, connBackend, outbound, backendErrors)

			if clientConn == nil {
				clientConn, err = w.upgradeClient(req, resp, rw)
				if err != nil {
					log.Errorf("KubeKindAggregatingWatchProxy: couldn't upgrade %s\n", err)
					return
				}
				defer clientConn.Close()
			}
		}
	}

	if log.GetLevel() >= log.DebugLevel {
		log.Debugf("Starting aggregating socket writer for %v...", req.URL)
	}
	errOutbound := make(chan error, 1)
	go w.writeMessages(clientConn, outbound, errOutbound)
	<-errOutbound
	if log.GetLevel() >= log.DebugLevel {
		log.Debugf("Closed aggregating socket writer for %v", req.URL)
	}
}

func (w *KubeKindAggregatingWatchProxy) upgradeClient(req *http.Request, resp *http.Response, rw http.ResponseWriter) (*websocket.Conn, error) {
	upgrader := w.Upgrader
	if w.Upgrader == nil {
		upgrader = DefaultUpgrader
	}

	// Only pass those headers to the upgrader.
	upgradeHeader := http.Header{}
	if hdr := resp.Header.Get("Sec-Websocket-Protocol"); hdr != "" {
		upgradeHeader.Set("Sec-Websocket-Protocol", hdr)
	}
	if hdr := resp.Header.Get("Set-Cookie"); hdr != "" {
		upgradeHeader.Set("Set-Cookie", hdr)
	}

	// Now upgrade the existing incoming request to a WebSocket connection.
	// Also pass the header that we gathered from the Dial handshake.
	if w.traceRequests {
		log.Infof("KubeKindAggregatingWatchProxy: upgrading request %v { %v }", req.URL, upgradeHeader)
	}
	return upgrader.Upgrade(rw, req, upgradeHeader)
}

func (w *KubeKindAggregatingWatchProxy) readMessages(backendURL *url.URL, socket *websocket.Conn, outbound chan []byte, errc chan error) {
	for {
		mt, message, err := socket.ReadMessage()
		if err != nil {
			errc <- err
			return
		}
		if w.traceRequests {
			log.Infof("Read message of type %d from %v: %s", mt, backendURL, string(message))
		}
		outbound <- message
	}
}

func (w *KubeKindAggregatingWatchProxy) writeMessages(socket *websocket.Conn, outbound chan []byte, errc chan error) {

	for {
		select {
		case message := <-outbound:
			err := socket.WriteMessage(websocket.TextMessage, message)
			if err != nil {
				errc <- err
				return
			}
			if w.traceRequests {
				log.Infof("Writing message to client: %s", string(message))
			}
		default:
		}
	}
}
