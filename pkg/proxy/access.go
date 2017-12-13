package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/matt-deboer/kuill/pkg/auth"
	"github.com/matt-deboer/kuill/pkg/clients"
	log "github.com/sirupsen/logrus"
	authorizationapi "k8s.io/api/authorization/v1"
)

// AccessAggregator provides aggregation for the multiple fine-grained
// SubjectAccessReview and SubjectRulesReview requests required in order to
// present a graphical UI over multiple resources and namespaces
type AccessAggregator struct {
	kubeClients     *clients.KubeClients
	authManager     *auth.Manager
	kindLister      *KindsProxy
	namespaceLister *NamespaceProxy
	bearerToken     string
}

func NewAccessProxy(kubeClients *clients.KubeClients,
	authManager *auth.Manager, kindLister *KindsProxy, namespaceLister *NamespaceProxy) *AccessAggregator {
	return &AccessAggregator{
		kubeClients:     kubeClients,
		authManager:     authManager,
		kindLister:      kindLister,
		namespaceLister: namespaceLister,
	}
}

// Serve returns an access permissions summary across all known namespaces for a given
// resource kind or multiple kinds
func (a *AccessAggregator) Serve(w http.ResponseWriter, r *http.Request, authContext auth.Context) {

	kind := r.URL.Query().Get("kind")
	if len(kind) == 0 {
		http.Error(w, "'kind' is required", http.StatusBadRequest)
		return
	}
	namespace := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	permissions, err := a.permissionsForResource(kind, namespace, name, authContext)
	if err != nil {
		log.Errorf("Error getting permissions for %s/%s/%s; %v", kind, namespace, name, err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
	}
	json.NewEncoder(w).Encode(permissions)
}

type kindPermissions struct {
	Get    bool `json:"get"`
	Put    bool `json:"put"`
	Delete bool `json:"delete"`
	Logs   bool `json:"logs"`
	Exec   bool `json:"exec"`
}

func (a *AccessAggregator) permissionsForResource(kind, namespace, name string, authContext auth.Context) (*kindPermissions, error) {
	namespaces, err := a.namespaceLister.getNamespaces()
	if err != nil {
		return nil, fmt.Errorf("Failed to list namespaces; %v", err)
	}

	if log.GetLevel() >= log.DebugLevel {
		log.Debugf("Evaluating permissions to %s/%s/%s for user %s [ groups: %v ]",
			kind, namespace, name, authContext.User(), authContext.Groups())
	}

	if len(kind) == 0 {
		return nil, fmt.Errorf("'kind' cannot be emptuy")
	}
	kubeKind := a.kindLister.GetKind(kind)
	podKind := a.kindLister.GetKind("Pod")
	permissions := make(chan Permission, 5)

	var wg sync.WaitGroup
	wg.Add(5)
	go a.getAccess(kubeKind, namespace, kubeKind.Plural, "", name, "get", namespaces, authContext, permissions, &wg)
	go a.getAccess(kubeKind, namespace, kubeKind.Plural, "", name, "put", namespaces, authContext, permissions, &wg)
	go a.getAccess(kubeKind, namespace, kubeKind.Plural, "", name, "delete", namespaces, authContext, permissions, &wg)
	go a.getAccess(podKind, namespace, "pods", "log", "", "get", namespaces, authContext, permissions, &wg)
	go a.getAccess(podKind, namespace, "pods", "exec", "", "get", namespaces, authContext, permissions, &wg)
	wg.Wait()

	var result kindPermissions
AssembleResults:
	for {
		select {
		case permission := <-permissions:
			if permission.Subresource == "log" && permission.Verb == "get" {
				result.Logs = true
			} else if permission.Subresource == "exec" && permission.Verb == "get" {
				result.Exec = true
			} else if permission.Verb == "put" {
				result.Put = true
			} else if permission.Verb == "delete" {
				result.Delete = true
			} else if permission.Verb == "get" {
				result.Get = true
			}
			break
		default:
			break AssembleResults
		}
	}
	return &result, nil
}

type APIResourcePermissions struct {
	*KubeKind
	Permissions []Permission
}

// WatchableAPIResource represents a resource for which the current user has
// 'watch' permissions, along with the namespaces in which the permission is
// granted; empty/omitted 'namespaces' list signifies permission to watch at
// the cluster scope
type WatchableAPIResource struct {
	*KubeKind
	Namespaces []string `json:"namespaces,omitempty"`
}

// Permission represents permission to perform a specific action
// on a kind in a namespace, with an optional subresource
type Permission struct {
	Kind        string
	Namespace   string
	Verb        string
	Subresource string
}

// GetWatchableResources returns a map of Kind => WatchableAPIResource
// representing all resources (and associated namespaces) for which the
// user specified in the provided authContext has permission to watch
func (a *AccessAggregator) GetWatchableResources(authContext auth.Context) (watchableKinds map[string]*WatchableAPIResource, count int, err error) {

	namespaces, err := a.namespaceLister.getNamespaces()
	if err != nil {
		return nil, 0, fmt.Errorf("Failed to list namespaces; %v", err)
	}

	watchable := make(chan Permission, len(a.kindLister.kinds)*len(namespaces))

	var wg sync.WaitGroup
	a.kindLister.mutex.RLock()
	for _, kind := range a.kindLister.kinds {
		wg.Add(1)
		go a.getAccess(kind, "", kind.Plural, "", "", "watch", namespaces, authContext, watchable, &wg)
	}
	a.kindLister.mutex.RUnlock()
	wg.Wait()

	result := make(map[string]*WatchableAPIResource)
AssembleResults:
	for {
		select {
		case permission := <-watchable:
			count++
			if w, exists := result[permission.Kind]; exists {
				w.Namespaces = append(w.Namespaces, permission.Namespace)
			} else {
				result[permission.Kind] = &WatchableAPIResource{
					KubeKind:   a.kindLister.GetKind(permission.Kind),
					Namespaces: []string{permission.Namespace},
				}
			}
		default:
			break AssembleResults
		}
	}
	return result, count, nil
}

func (a *AccessAggregator) getAccess(kubeKind *KubeKind, namespace, resource, subresource, name, verb string,
	namespaces []string, authContext auth.Context, results chan Permission, wg *sync.WaitGroup) {

	attrs := &authorizationapi.ResourceAttributes{
		Group:     "",
		Namespace: namespace,
		Resource:  resource,
		Verb:      verb,
		Version:   "*",
	}

	if strings.HasPrefix(kubeKind.APIBase, "apis/") {
		attrs.Group = strings.Split(kubeKind.APIBase, "/")[1]
	}

	if len(subresource) > 0 {
		attrs.Subresource = subresource
	}

	if len(name) > 0 {
		attrs.Name = name
	}

	result, err := a.kubeClients.Standard.Authorization().SubjectAccessReviews().Create(
		&authorizationapi.SubjectAccessReview{
			Spec: authorizationapi.SubjectAccessReviewSpec{
				User:               authContext.User(),
				Groups:             authContext.Groups(),
				ResourceAttributes: attrs,
			},
		})

	if err != nil {
		log.Errorf("Error while testing access to %s %s %s in namespace '%s'; %v",
			verb, resource, subresource, namespace, err)
	} else if !result.Status.Allowed {
		if namespace == "" {
			if log.GetLevel() >= log.DebugLevel {
				log.Debugf("Not allowed to '%s' %s at the cluster scope; testing namespace access...",
					verb, resource)
			}
			wg.Add(len(namespaces))
			for _, ns := range namespaces {
				go a.getAccess(kubeKind, ns, resource, subresource, name, verb,
					namespaces, authContext, results, wg)
			}
		} else if log.GetLevel() >= log.DebugLevel {
			log.Debugf("User %s %v is NOT allowed to '%s' %s/%s/%s",
				authContext.User(), authContext.Groups(), verb, kubeKind.Kind, namespace, name)
		}
	} else {
		if log.GetLevel() >= log.DebugLevel {
			log.Debugf("User %s %v has access to '%s' %s/%s/%s",
				authContext.User(), authContext.Groups(), verb, kubeKind.Kind, namespace, name)
		}
		results <- Permission{
			Kind:        kubeKind.Kind,
			Verb:        verb,
			Namespace:   namespace,
			Subresource: subresource,
		}
	}

	wg.Done()
}
