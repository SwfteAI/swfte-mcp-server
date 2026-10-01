package com.acme.portal.domain;

/** A row of the orders table; {@code workflowId} is the fulfilment workflow chosen for the order's region. */
public record OrderRecord(String id, String sku, String notes, String workflowId) {
}
