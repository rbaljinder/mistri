/** Private synthetic inventory IDs are labels, never authority. */
export const tenantInventoryModel = Object.freeze({
  appId: 'tenant-ignition-inventory',
  appName: 'Ignition · Tenant inventory',
  vehicle: 'vehicle',
  reservation: 'vehicle_reservation',
  history: 'availability_history',
  reserve: 'reserveVehicle',
  release: 'releaseReservation',
  reserveAction: 'Reserve vehicle',
  releaseAction: 'Release reservation',
});

export const tenantInventoryRows = Object.freeze({
  north: Object.freeze({
    vehicle: 'northstar-vehicle',
    otherVehicle: 'northstar-other-vehicle',
    unavailableVehicle: 'northstar-unavailable-vehicle',
    staleVehicle: 'northstar-stale-vehicle',
    missingReservationVehicle: 'northstar-missing-reservation-vehicle',
    inconsistentVehicle: 'northstar-inconsistent-vehicle',
    inconsistentReservation: 'northstar-inconsistent-reservation',
    hiddenReservationVehicle: 'northstar-hidden-reservation-vehicle',
    hiddenReservation: 'northstar-hidden-reservation',
    hiddenUnit: 'northstar-private',
    hiddenLead: 'northstar-private-work',
    hiddenStaff: 'northstar-private-manager',
    reservedVehicle: 'northstar-reserved-vehicle',
    reservation: 'northstar-reservation',
    staleReservedVehicle: 'northstar-stale-reserved-vehicle',
    staleReservation: 'northstar-stale-reservation',
    releasedReservation: 'northstar-released-reservation',
  }),
  south: Object.freeze({
    vehicle: 'riverview-vehicle',
    reservedVehicle: 'riverview-reserved-vehicle',
    reservation: 'riverview-reservation',
  }),
});
