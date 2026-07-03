export interface paths {
    "/pdf/compress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Queue one or more PDF files for compression
         * @description Validate and store the uploads, then queue a compression job.
         */
        post: operations["compress_pdf_compress_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pdf/unlock": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Queue a password removal job for a PDF file
         * @description Validate and store the upload, then queue an unlock job.
         */
        post: operations["unlock_pdf_unlock_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pdf/lock": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Queue a password protection job for a PDF file
         * @description Validate and store the upload, then queue a lock job.
         */
        post: operations["lock_pdf_lock_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pdf/merge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Queue a merge of two or more PDF files
         * @description Validate and store the uploads, then queue a merge job.
         */
        post: operations["merge_pdf_merge_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pdf/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Queue a rotate/reorder of a PDF's pages
         * @description Validate and store the upload, then queue a rotate job.
         */
        post: operations["rotate_pdf_rotate_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pdf/convert": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Queue a file conversion
         * @description Validate the upload(s) and conversion pair, then queue a convert job.
         */
        post: operations["convert_pdf_convert_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{job_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Poll a job's status */
        get: operations["job_status_jobs__job_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{job_id}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Download a finished job's result */
        get: operations["job_download_jobs__job_id__download_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/queue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Public queue board */
        get: operations["queue_board_queue_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Liveness check
         * @description Return a status payload used by load balancers, uptime checks, and
         *     bug reports (the commit identifies the running deploy).
         */
        get: operations["health_health_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * BoardEntry
         * @description Anonymized public view of one job. Never includes filenames.
         */
        BoardEntry: {
            /** Id Prefix */
            id_prefix: string;
            /** Tool */
            tool: string;
            /** File Count */
            file_count: number;
            /** Total Bytes */
            total_bytes: number;
            /** Created At */
            created_at: number;
        };
        /** Body_compress_pdf_compress_post */
        Body_compress_pdf_compress_post: {
            /**
             * Files
             * @description One or more PDF files to compress.
             */
            files: string[];
            /**
             * @description Compression preset; 'screen' is smallest, 'prepress' is highest quality.
             * @default ebook
             */
            quality: components["schemas"]["CompressionQuality"];
        };
        /** Body_convert_pdf_convert_post */
        Body_convert_pdf_convert_post: {
            /**
             * Files
             * @description The file to convert (multiple images may combine into one PDF).
             */
            files: string[];
            /**
             * Target
             * @description Target format: pdf, docx, md, html, txt, png, or jpeg.
             */
            target: string;
            /**
             * Dpi
             * @description Resolution for png/jpeg targets: 72, 150, or 300.
             */
            dpi?: number | null;
        };
        /** Body_lock_pdf_lock_post */
        Body_lock_pdf_lock_post: {
            /**
             * File
             * Format: binary
             * @description A PDF to password-protect.
             */
            file: string;
            /**
             * Password
             * @description The password that will be required to open the PDF.
             */
            password: string;
            /**
             * Allow Printing
             * @description Permit printing the locked PDF.
             * @default true
             */
            allow_printing: boolean;
            /**
             * Allow Copying
             * @description Permit copying/extracting text from the PDF.
             * @default false
             */
            allow_copying: boolean;
            /**
             * Allow Editing
             * @description Permit editing and annotating the PDF.
             * @default false
             */
            allow_editing: boolean;
            /**
             * @description Encryption strength; 'aes-256' is strongest.
             * @default aes-256
             */
            encryption: components["schemas"]["EncryptionLevel"];
        };
        /** Body_merge_pdf_merge_post */
        Body_merge_pdf_merge_post: {
            /**
             * Files
             * @description Two or more PDF files, in merge order.
             */
            files: string[];
        };
        /** Body_rotate_pdf_rotate_post */
        Body_rotate_pdf_rotate_post: {
            /**
             * File
             * Format: binary
             * @description The PDF whose pages to rotate/reorder.
             */
            file: string;
            /**
             * Pages
             * @description JSON list of {"index", "rotation"}; array order is the new page order.
             */
            pages: string;
        };
        /** Body_unlock_pdf_unlock_post */
        Body_unlock_pdf_unlock_post: {
            /**
             * File
             * Format: binary
             * @description A password-protected PDF to unlock.
             */
            file: string;
            /**
             * Password
             * @description The password that opens the PDF.
             */
            password: string;
        };
        /**
         * CompressionQuality
         * @description Quality presets that map directly to Ghostscript's -dPDFSETTINGS values.
         *
         *     Lower quality means smaller files: `screen` is the most aggressive,
         *     `prepress` preserves the most detail.
         * @enum {string}
         */
        CompressionQuality: "screen" | "ebook" | "printer" | "prepress";
        /**
         * EncryptionLevel
         * @description Encryption strength presets exposed by the API.
         * @enum {string}
         */
        EncryptionLevel: "aes-128" | "aes-256";
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /** JobAccepted */
        JobAccepted: {
            /** Job Id */
            job_id: string;
            /** Position */
            position: number | null;
            /** Queue Size */
            queue_size: number;
        };
        /**
         * JobStatus
         * @enum {string}
         */
        JobStatus: "queued" | "processing" | "done" | "failed";
        /** JobStatusResponse */
        JobStatusResponse: {
            /** Id */
            id: string;
            /** Tool */
            tool: string;
            status: components["schemas"]["JobStatus"];
            /** Position */
            position: number | null;
            /** Queue Size */
            queue_size: number;
            /** Error */
            error: string | null;
            /** File Count */
            file_count: number;
            /** Total Bytes */
            total_bytes: number;
            /** Created At */
            created_at: number;
        };
        /** QueueBoard */
        QueueBoard: {
            /** Concurrency */
            concurrency: number;
            /** Jobs Completed */
            jobs_completed: number;
            /** Processing */
            processing: components["schemas"]["BoardEntry"][];
            /** Waiting */
            waiting: components["schemas"]["BoardEntry"][];
        };
        /** ValidationError */
        ValidationError: {
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    compress_pdf_compress_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_compress_pdf_compress_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    unlock_pdf_unlock_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_unlock_pdf_unlock_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    lock_pdf_lock_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_lock_pdf_lock_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    merge_pdf_merge_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_merge_pdf_merge_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    rotate_pdf_rotate_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_rotate_pdf_rotate_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    convert_pdf_convert_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_convert_pdf_convert_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    job_status_jobs__job_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobStatusResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    job_download_jobs__job_id__download_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    queue_board_queue_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QueueBoard"];
                };
            };
        };
    };
    health_health_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: string;
                    };
                };
            };
        };
    };
}
