

context('Cluster Admin', function(){
  beforeEach(function(){
    cy.login('admin', 'password')
  })

  afterEach(function(){
    // cy.logout()
  })

  it('should see all supported actions', function() {
    cy.get('#goto-workloads').click()
    cy.get('.workloads-page')

    cy.get(`table.filter-table.workloads > tbody 
      tr.Deployment_kube-system_kube-dns 
      td.resource-actions > svg`)
      .scrollIntoView().click()
    
    cy.get('div.actions-popover div')
      .children('button.row-action')
      .each(function(button) {
        expect(button.context.id).to.match(/row-action:(edit|logs|exec|delete|scale|suspend)/)
      })
  })

  it('can create new resources', function() {
    cy.get('#goto-workloads').click()
    cy.get('.workloads-page')
    
    cy.get('div.new-workload > button')
      .click()
  })
})