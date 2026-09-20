create index if not exists idx_merchant_policies_merchant_policy
  on merchant_policies(merchant_id,policy_id);
create index if not exists idx_merchant_documents_merchant_document
  on merchant_documents(merchant_id,document_id);
