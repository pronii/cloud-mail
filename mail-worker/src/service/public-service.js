import BizError from '../error/biz-error';
import orm from '../entity/orm';
import { v4 as uuidv4 } from 'uuid';
import { and, asc, desc, eq, sql, inArray } from 'drizzle-orm';
import saltHashUtils from '../utils/crypto-utils';
import cryptoUtils from '../utils/crypto-utils';
import emailUtils from '../utils/email-utils';
import roleService from './role-service';
import verifyUtils from '../utils/verify-utils';
import { t } from '../i18n/i18n';
import reqUtils from '../utils/req-utils';
import dayjs from 'dayjs';
import { isDel, roleConst, emailConst, settingConst } from '../const/entity-const';
import email from '../entity/email';
import userService from './user-service';
import KvConst from '../const/kv-const';
import emailService from './email-service';
import settingService from './setting-service';
import accountService from './account-service';
import attService from './att-service';
import { Resend } from 'resend';
import { parseHTML } from 'linkedom';

const publicService = {

	async emailList(c, params) {

		let { toEmail, content, subject, sendName, sendEmail, timeSort, num, size, type , isDel } = params

		const query = orm(c).select({
				emailId: email.emailId,
				sendEmail: email.sendEmail,
				sendName: email.name,
				subject: email.subject,
				toEmail: email.toEmail,
				toName: email.toName,
				type: email.type,
				createTime: email.createTime,
				content: email.content,
				text: email.text,
				isDel: email.isDel,
		}).from(email)

		if (!size) {
			size = 20
		}

		if (!num) {
			num = 1
		}

		size = Number(size);
		num = Number(num);

		num = (num - 1) * size;

		let conditions = []

		if (toEmail) {
			conditions.push(sql`${email.toEmail} COLLATE NOCASE LIKE ${toEmail}`)
		}

		if (sendEmail) {
			conditions.push(sql`${email.sendEmail} COLLATE NOCASE LIKE ${sendEmail}`)
		}

		if (sendName) {
			conditions.push(sql`${email.name} COLLATE NOCASE LIKE ${sendName}`)
		}

		if (subject) {
			conditions.push(sql`${email.subject} COLLATE NOCASE LIKE ${subject}`)
		}

		if (content) {
			conditions.push(sql`${email.content} COLLATE NOCASE LIKE ${content}`)
		}

		if (type || type === 0) {
			conditions.push(eq(email.type, type))
		}

		if (isDel || isDel === 0) {
			conditions.push(eq(email.isDel, isDel))
		}

		if (conditions.length === 1) {
			query.where(...conditions)
		} else if (conditions.length > 1) {
			query.where(and(...conditions))
		}

		if (timeSort === 'asc') {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		return query.limit(size).offset(num);

	},

	async addUser(c, params) {
		const { list } = params;

		if (list.length === 0) return;

		for (const emailRow of list) {
			if (!verifyUtils.isEmail(emailRow.email)) {
				throw new BizError(t('notEmail'));
			}

			if (!c.env.domain.includes(emailUtils.getDomain(emailRow.email))) {
				throw new BizError(t('notEmailDomain'));
			}

			const { salt, hash } = await saltHashUtils.hashPassword(
				emailRow.password || cryptoUtils.genRandomPwd()
			);

			emailRow.salt = salt;
			emailRow.hash = hash;
		}


		const activeIp = reqUtils.getIp(c);
		const { os, browser, device } = reqUtils.getUserAgent(c);
		const activeTime = dayjs().format('YYYY-MM-DD HH:mm:ss');

		const roleList = await roleService.roleSelectUse(c);
		const defRole = roleList.find(roleRow => roleRow.isDefault === roleConst.isDefault.OPEN);

		const userList = [];

		for (const emailRow of list) {
			let { email, hash, salt, roleName } = emailRow;
			let type = defRole.roleId;

			if (roleName) {
				const roleRow = roleList.find(role => role.name === roleName);
				type = roleRow ? roleRow.roleId : type;
			}

			const userSql = `INSERT INTO user (email, password, salt, type, os, browser, active_ip, create_ip, device, active_time, create_time)
			VALUES ('${email}', '${hash}', '${salt}', '${type}', '${os}', '${browser}', '${activeIp}', '${activeIp}', '${device}', '${activeTime}', '${activeTime}')`

			const accountSql = `INSERT INTO account (email, name, user_id)
			VALUES ('${email}', '${emailUtils.getName(email)}', 0);`;

			userList.push(c.env.db.prepare(userSql));
			userList.push(c.env.db.prepare(accountSql));

		}

		userList.push(c.env.db.prepare(`UPDATE account SET user_id = (SELECT user_id FROM user WHERE user.email = account.email) WHERE user_id = 0;`))

		try {
			await c.env.db.batch(userList);
		} catch (e) {
			if(e.message.includes('SQLITE_CONSTRAINT')) {
				throw new BizError(t('emailExistDatabase'))
			} else {
				throw e
			}
		}

	},

	async genToken(c, params) {

		await this.verifyUser(c, params)

		const uuid = uuidv4();

		await c.env.kv.put(KvConst.PUBLIC_KEY, uuid);

		return {token: uuid}
	},

	async verifyUser(c, params) {

		const { email, password } = params

		const userRow = await userService.selectByEmailIncludeDel(c, email);

		if (email !== c.env.admin) {
			throw new BizError(t('notAdmin'));
		}

		if (!userRow || userRow.isDel === isDel.DELETE) {
			throw new BizError(t('notExistUser'));
		}

		if (!await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
			throw new BizError(t('IncorrectPwd'));
		}
	},

	async sendEmail(c, params) {
		let {
			accountId,
			name,
			sendType,
			emailId,
			receiveEmail,
			manyType,
			text,
			content,
			subject,
			attachments,
			adminEmail,
			adminPassword
		} = params;

		// 验证管理员身份
		await this.verifyUser(c, { email: adminEmail, password: adminPassword });

		const { resendTokens, r2Domain, send } = await settingService.query(c);

		if (send === settingConst.send.CLOSE) {
			throw new BizError(t('disabledSend'), 403);
		}

		// 验证收件人邮箱格式
		if (!receiveEmail || receiveEmail.length === 0) {
			throw new BizError(t('emptyRecipientMsg'));
		}

		// 验证收件人邮箱数量限制（防止滥用）
		if (receiveEmail.length > 100) { // 限制单次发送数量
			throw new BizError('单次发送邮件收件人数量不能超过100个');
		}

		for (const email of receiveEmail) {
			if (!verifyUtils.isEmail(email)) {
				throw new BizError(t('notEmail'));
			}
		}

		// 验证邮件内容和主题长度限制
		if (subject && subject.length > 500) {
			throw new BizError('邮件主题长度不能超过500个字符');
		}

		if (content && content.length > 100000) { // 100KB 限制
			throw new BizError('邮件内容长度不能超过100000个字符');
		}

		if (text && text.length > 100000) { // 100KB 限制
			throw new BizError('邮件文本内容长度不能超过100000个字符');
		}

		// 验证发件人账户
		const accountRow = await accountService.selectById(c, accountId);

		if (!accountRow) {
			throw new BizError(t('senderAccountNotExist'));
		}

		// 获取域名对应的Resend令牌
		const domain = emailUtils.getDomain(accountRow.email);
		const resendToken = resendTokens[domain];

		if (!resendToken) {
			throw new BizError(t('noResendToken'));
		}

		if (!name) {
			name = emailUtils.getName(accountRow.email);
		}

		// 准备发送邮件
		const resend = new Resend(resendToken);

		let resendResult = null;

		// 如果是回复邮件，需要获取原始邮件信息
		let emailRow = { messageId: null };
		if (sendType === 'reply' && emailId) {
			emailRow = await emailService.selectById(c, emailId);
			if (!emailRow) {
				throw new BizError(t('notExistEmailReply'));
			}
		}

		// 如果是分开发送
		if (manyType === 'divide') {
			if (attachments && attachments.length > 0) {
				throw new BizError(t('noSeparateSend'));
			}

			const sendFormList = receiveEmail.map(email => ({
				from: `${name} <${accountRow.email}>`,
				to: [email],
				subject: subject,
				text: text,
				html: content
			}));

			if (sendType === 'reply') {
				sendFormList.forEach(sendForm => {
					sendForm.headers = {
						'in-reply-to': emailRow.messageId,
						'references': emailRow.messageId
					};
				});
			}

			resendResult = await resend.batch.send(sendFormList);
		} else {
			const sendForm = {
				from: `${name} <${accountRow.email}>`,
				to: [...receiveEmail],
				subject: subject,
				text: text,
				html: content,
				attachments: attachments || []
			};

			if (sendType === 'reply') {
				sendForm.headers = {
					'in-reply-to': emailRow.messageId,
					'references': emailRow.messageId
				};
			}

			resendResult = await resend.emails.send(sendForm);
		}

		const { data, error } = resendResult;

		if (error) {
			throw new BizError(error.message);
		}

		// 在数据库中保存邮件记录
		const emailData = {};
		emailData.sendEmail = accountRow.email;
		emailData.name = name;
		emailData.subject = subject;
		emailData.content = content;
		emailData.text = text;
		emailData.accountId = accountId;
		emailData.type = emailConst.type.SEND;
		emailData.status = emailConst.status.SENT;

		// 为管理员用户添加邮件记录
		const adminUser = await userService.selectByEmailIncludeDel(c, adminEmail);
		emailData.userId = adminUser.userId;

		const emailDataList = [];

		if (manyType === 'divide') {
			receiveEmail.forEach((item, index) => {
				const emailDataItem = { ...emailData };
				emailDataItem.resendEmailId = data.data[index].id;
				emailDataItem.recipient = JSON.stringify([{ address: item, name: '' }]);
				emailDataList.push(emailDataItem);
			});
		} else {
			emailData.resendEmailId = data.id;

			const recipient = receiveEmail.map(item => ({ address: item, name: '' }));
			emailData.recipient = JSON.stringify(recipient);

			emailDataList.push(emailData);
		}

		if (sendType === 'reply') {
			emailDataList.forEach(emailData => {
				emailData.inReplyTo = emailRow.messageId;
				emailData.relation = emailRow.messageId;
			});
		}

		// 保存邮件记录到数据库
		const emailRowList = await Promise.all(
			emailDataList.map(async (emailData) => {
				return await orm(c).insert(email).values(emailData).returning().get();
			})
		);

		return emailRowList;
	}

}

export default publicService
