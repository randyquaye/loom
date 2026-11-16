# Preserve the existing GoDaddy records when DNS authority moves to Route53.
resource "aws_route53_record" "existing" {
  for_each = var.manage_dns ? {
    pilot = {
      type    = "A"
      ttl     = 600
      records = ["13.61.243.238"]
    }
    _dmarc = {
      type    = "TXT"
      ttl     = 3600
      records = ["v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;"]
    }
    _domainconnect = {
      type    = "CNAME"
      ttl     = 3600
      records = ["_domainconnect.gd.domaincontrol.com."]
    }
  } : {}

  zone_id = aws_route53_zone.site[0].zone_id
  name    = "${each.key}.${var.domain}"
  type    = each.value.type
  ttl     = each.value.ttl
  records = each.value.records
}
