#!/bin/bash

KUILL_PORT=8889
SCRIPT_DIR=$(cd $(dirname $0) && pwd)
MINIKUBE_SUDO=${MINIKUBE_SUDO:-}

# launch a new minikube environment
CI=true KUILL_PORT=${KUILL_PORT} ${MINIKUBE_SUDO} ${SCRIPT_DIR}/minikube-dev.sh &

# Save the PID of the server to a variable
KUILL_PID=$!
echo "KUILL pid: ${KUILL_PID}"

${MINIKUBE_SUDO} kubectl --context minikube apply -f ${SCRIPT_DIR}/aceptance-tests/manifests/

# Execute tests
pushd ${SCRIPT_DIR}/../pkg/ui > /dev/null
CYPRESS_BASE_URL="https://localhost:${KUILL_PORT}" npm run cypress:run
TEST_RESULTS=$?
popd > /dev/null

# Kill the server
kill $KUILL_PID
kill $(pgrep kuill)

exit $TEST_RESULTS