import path from 'path'
import fs from 'fs-extra'

// https://github.com/cojs/busboy/issues/30
// https://github.com/brentburg/chan/pull/18
import busboy           from 'async-busboy'
import file_size_parser from 'filesize-parser'
import mount            from 'koa-mount'
import uid              from 'uid-safe'

import promisify from '../promisify'
import errors    from '../errors'

export default function({ mount_path = '/', upload_folder, requires_authentication = false, multiple_files = false, on_file_uploaded, postprocess, file_size_limit }, log)
{
	return mount(mount_path, async function(ctx)
	{
		if (!ctx.is('multipart/form-data'))
		{
			throw new errors.Unsupported_input_type(`This is supposed to be a "multipart/form-data" http request`)
		}

		if (requires_authentication !== false && !ctx.user)
		{
			throw new errors.Unauthenticated()
		}

		const file_names = []

		const form_data = await busboy(ctx.req,
		{
			limits:
			{
				fileSize: file_size_limit ? file_size_parser(file_size_limit) : undefined
			}
		})

		// const parameters = {}

		// non-channel approach, since `chan` package currently doesn't support async/await
		const { files, fields } = form_data
		const parameters = fields

		// let form_data_item
		// while (form_data_item = yield form_data)
		for (let form_data_item of files)
		{
			if (!multiple_files && file_names.not_empty())
			{
				throw new Error(`Multiple files are being uploaded to a single file upload endpoint`)
			}

			// if (Array.isArray(form_data_item))
			// {
			// 	parameters[form_data_item[0]] = form_data_item[1]
			// 	continue
			// }

			const file_name = await upload_file(form_data_item, { upload_folder, log })

			file_names.push
			({
				original_file_name: form_data_item.filename,
				uploaded_file_name: file_name
			})

			if (on_file_uploaded)
			{
				const file_size = (await promisify(fs.stat, fs)(path.join(upload_folder, file_name))).size

				await on_file_uploaded(form_data_item.filename, file_size, ctx.request.headers['x-forwarded-for'] || ctx.request.ip)
			}
		}

		let result

		if (multiple_files)
		{
			result = { files: file_names, parameters }
		}
		else
		{
			result = { file: file_names[0], parameters }
		}

		if (postprocess)
		{
			result = await postprocess.call(this, result)
		}

		ctx.body = result
	})
}

// checks if filesystem path exists
function fs_exists(path)
{
	return new Promise((resolve, reject) => 
	{
		fs.exists(path, exists => resolve(exists))
	})
}

// generates a unique temporary file name
async function generate_unique_filename(folder, options)
{
	// 24 bytes
	let file_name = uid.sync(24)

	if (options.dot_extension)
	{
		file_name += options.dot_extension
	}

	const exists = await fs_exists(path.join(folder, file_name))

	if (!exists)
	{
		return file_name
	}

	if (options.log)
	{
		options.log.info(`Generate unique file name: collision for "${file_name}". Taking another try.`)
	}

	return await generate_unique_filename(folder, options)
}

// handles file upload
async function upload_file(file, { upload_folder, log })
{
	if (log)
	{
		log.debug(`Uploading: ${file.filename}`)
	}
		
	const file_name = await generate_unique_filename(upload_folder, { log }) // dot_extension: path.extname(file.filename), 
	const output_file = path.join(upload_folder, file_name)

	return await new Promise((resolve, reject) =>
	{
		fs.ensureDir(upload_folder, (error) =>
		{
			if (error)
			{
				return reject(error)
			}

			const stream = fs.createWriteStream(output_file)

			file.pipe(stream)
				.on('finish', () => resolve(path.relative(upload_folder, output_file)))
				.on('error', error => reject(error))
		})
	})
}