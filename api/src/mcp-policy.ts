export const commonTools = ['get_batch_summary','get_batch_status','get_validation_summary','get_certificate_status','get_proof_status'] as const;
export const bots = [
 {path:'tachibana',id:'tachibana_pm',name:'橘 司',role:'PM',secret:'MCP_TACHIBANA_TOKEN',tools:['get_all_reviews','get_workflow_status','submit_pm_review']},
 {path:'sanada',id:'sanada_engineering',name:'真田 蓮',role:'Engineering',secret:'MCP_SANADA_TOKEN',tools:['get_technical_summary','get_certificate_proof_status','submit_engineering_review']},
 {path:'mido',id:'mido_security',name:'御堂 玲',role:'Security',secret:'MCP_MIDO_TOKEN',tools:['get_security_summary','check_duplicate_summary','get_auth_security_status','submit_security_review']},
 {path:'shiraishi',id:'shiraishi_compliance',name:'白石 律',role:'Compliance',secret:'MCP_SHIRAISHI_TOKEN',tools:['get_compliance_summary','get_consent_summary','get_pii_exposure_summary','submit_compliance_review']},
 {path:'mizuki',id:'mizuki_customer',name:'水城 澪',role:'Customer',secret:'MCP_MIZUKI_TOKEN',tools:['get_notification_summary','get_verify_preview','submit_customer_review']},
] as const;
export type Bot = typeof bots[number];
export type BotSecrets = Partial<Record<typeof bots[number]['secret'], string>>;
export const allowedTools = (bot: Bot): readonly string[] => [...commonTools,...bot.tools];
